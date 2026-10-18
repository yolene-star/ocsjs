import type { QuizQuestion } from './deepseek-quiz';

export interface BankQuestion extends QuizQuestion {
	kind?: string;
}
export interface BankAnswer {
	indices: number[];
	source: string;
	verified: boolean;
}
interface BankEntry {
	question: BankQuestion;
	answers: string[];
	source: string;
	verified: boolean;
	updatedAt: number;
}
interface BankStorage {
	read(): unknown;
	write(value: { version: number; entries: BankEntry[] }): void;
}

const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
export function choiceOptionTexts(question: BankQuestion): string[] {
	const options = question.options.map(normalize);
	const labels = options.map(
		(_, index) => new RegExp('^' + String.fromCharCode(65 + index) + '(?:[.、:)\\]]\\s*|\\s+)')
	);
	const labelled = options.every((value, index) => labels[index].test(value));
	return options.map((value, index) => (labelled ? value.replace(labels[index], '').trim() : value));
}
const titleText = (value: string) =>
	normalize(value)
		.replace(/^\d+\s*[.、]\s*/, '')
		.replace(/^[\[【](?:单选题|多选题|判断题)[\]】]\s*/, '');
const kind = (q: BankQuestion) => q.kind || (/判断题/.test(q.title) ? 'judgement' : q.multiple ? 'multiple' : 'single');
const questionKey = (q: BankQuestion) => JSON.stringify([titleText(q.title), kind(q), choiceOptionTexts(q).sort()]);

function validIndices(q: BankQuestion, indices: number[]): boolean {
	return (
		Array.isArray(indices) &&
		indices.length > 0 &&
		(q.multiple || indices.length === 1) &&
		new Set(indices).size === indices.length &&
		indices.every((i) => Number.isInteger(i) && i >= 0 && i < q.options.length)
	);
}

function validateEntry(entry: any): entry is BankEntry {
	return (
		!!entry &&
		typeof entry.question?.title === 'string' &&
		!!entry.question.title.trim() &&
		typeof entry.question.multiple === 'boolean' &&
		Array.isArray(entry.question.options) &&
		entry.question.options.length >= 2 &&
		entry.question.options.length <= 26 &&
		entry.question.options.every((s: unknown) => typeof s === 'string' && !!s.trim()) &&
		(entry.question.kind === undefined || ['single', 'multiple', 'judgement'].includes(entry.question.kind)) &&
		Array.isArray(entry.answers) &&
		entry.answers.length > 0 &&
		(entry.question.multiple || entry.answers.length === 1) &&
		entry.answers.every(
			(s: unknown) => typeof s === 'string' && !!s.trim() && choiceOptionTexts(entry.question).includes(s)
		) &&
		new Set(entry.answers).size === entry.answers.length &&
		typeof entry.source === 'string' &&
		typeof entry.verified === 'boolean' &&
		Number.isFinite(entry.updatedAt)
	);
}

/** Persistent, option-aware bank, separate from the upstream 200-question title-only cache. */
export class LocalQuestionBank {
	private storage: BankStorage;
	constructor(storage: BankStorage) {
		this.storage = storage;
	}
	entries(): BankEntry[] {
		const value = this.storage.read() as any;
		return value?.version === 1 && Array.isArray(value.entries) ? value.entries.filter(validateEntry) : [];
	}
	find(question: BankQuestion): BankAnswer | undefined {
		const entry = this.entries().find((e) => questionKey(e.question) === questionKey(question));
		if (!entry) return;
		const texts = choiceOptionTexts(question);
		const indices = entry.answers.map((answer) => texts.indexOf(answer));
		if (!validIndices(question, indices) || indices.some((i) => texts.lastIndexOf(texts[i]) !== i)) return;
		return { indices, source: entry.source, verified: entry.verified };
	}
	put(question: BankQuestion, indices: number[], source: string, verified: boolean): void {
		if (!validIndices(question, indices)) throw new Error('答案选项无效，未保存到本地题库。');
		const entries = this.entries();
		const key = questionKey(question);
		const previous = entries.find((e) => questionKey(e.question) === key);
		if (previous?.verified && !verified) return;
		const entry: BankEntry = {
			question: { ...question, options: [...question.options] },
			answers: indices.map((i) => choiceOptionTexts(question)[i]),
			source,
			verified,
			updatedAt: Date.now()
		};
		if (!validateEntry(entry)) throw new Error('题目格式无效，未保存到本地题库。');
		this.storage.write({
			version: 1,
			entries: [entry, ...entries.filter((e) => questionKey(e.question) !== key)].slice(0, 5000)
		});
	}
	export(): string {
		return JSON.stringify({ version: 1, entries: this.entries() }, null, 2);
	}
	import(text: string): number {
		let value: any;
		try {
			value = JSON.parse(text.replace(/^\uFEFF/, ''));
		} catch {
			throw new Error('题库文件不是有效的 JSON。');
		}
		if (
			value?.version !== 1 ||
			!Array.isArray(value.entries) ||
			value.entries.length > 5000 ||
			!value.entries.every(validateEntry)
		) {
			throw new Error('题库格式不匹配或存在无效记录，未导入。请使用本定制版导出的题库文件。');
		}
		const merged = new Map<string, BankEntry>();
		for (const entry of [...this.entries(), ...value.entries]) {
			const key = questionKey(entry.question);
			const old = merged.get(key);
			if (
				!old ||
				(!old.verified && entry.verified) ||
				(old.verified === entry.verified && entry.updatedAt > old.updatedAt)
			) {
				merged.set(key, entry);
			}
		}
		this.storage.write({
			version: 1,
			entries: Array.from(merged.values())
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, 5000)
		});
		return value.entries.length;
	}
}

export function createBrowserQuestionBank(): LocalQuestionBank {
	const key = 'ocs.deepseek.question-bank.v1';
	return new LocalQuestionBank({
		read: () => GM_getValue(key, { version: 1, entries: [] }),
		write: (value) => {
			GM_setValue(key, value);
		}
	});
}

export function matchChoiceAnswer(answer: string, question: BankQuestion): number[] | undefined {
	const texts = choiceOptionTexts(question);
	const normalized = normalize(answer);
	let indices: number[];
	if (texts.includes(normalized)) {
		indices = [texts.indexOf(normalized)];
	} else if (/^[A-Z](?:[A-Z\s,，、#;；|]*[A-Z])?$/.test(normalized)) {
		indices = (normalized.match(/[A-Z]/g) || []).map((letter) => letter.charCodeAt(0) - 65);
	} else {
		const parts = answer
			.split(/[#\n;；|]+/)
			.map(normalize)
			.filter(Boolean);
		indices = parts.map((part) => texts.indexOf(part));
	}
	if (!validIndices(question, indices) || indices.some((i) => texts.lastIndexOf(texts[i]) !== i)) return;
	return indices;
}

export function readPublishedAnswer(text: string, question: BankQuestion): number[] | undefined {
	const match = text.match(/正确答案\s*[:：]\s*([A-Z](?:[A-Z\s,，、#;；]*[A-Z])?)(?=\s|$|[^A-Za-z])/);
	return match ? matchChoiceAnswer(match[1].trim(), question) : undefined;
}

export function pickOnlineAnswer(
	infos: { name: string; results: { question: string; answer: string }[] }[],
	question: BankQuestion
): BankAnswer | undefined {
	for (const info of infos) {
		for (const candidate of info.results || []) {
			if (!candidate.question || titleText(candidate.question) !== titleText(question.title)) continue;
			const indices = candidate.answer && matchChoiceAnswer(candidate.answer, question);
			if (indices) return { indices, source: info.name, verified: false };
		}
	}
}

/** All callers share one in-flight pipeline for the same question. No remote call on a local hit. */
export class HybridAnswerer {
	private bank: LocalQuestionBank;
	private inFlight = new Map<string, Promise<BankAnswer>>();
	constructor(bank: LocalQuestionBank) {
		this.bank = bank;
	}
	answer(
		question: BankQuestion,
		online: () => Promise<BankAnswer | undefined>,
		ai: () => Promise<number[]>
	): Promise<BankAnswer> {
		const local = this.bank.find(question);
		if (local) return Promise.resolve({ ...local, source: `本地题库（${local.source}）` });
		const key = questionKey(question);
		const pending = this.inFlight.get(key);
		if (pending)
			return pending.then((result) => {
				const mapped = this.bank.find(question);
				if (!mapped) throw new Error('共享查询的选项已变化，请重试。');
				return { ...result, indices: mapped.indices };
			});
		const work = (async () => {
			let remote: BankAnswer | undefined;
			try {
				remote = await online();
			} catch {
				/* Online outage may fall back to configured API. */
			}
			if (remote && validIndices(question, remote.indices)) {
				this.bank.put(question, remote.indices, remote.source, remote.verified);
				return remote;
			}
			const indices = await ai();
			if (!validIndices(question, indices)) throw new Error('DeepSeek 没有返回有效答案，未写入题库。');
			this.bank.put(question, indices, 'DeepSeek', false);
			return { indices, source: 'DeepSeek（未验证）', verified: false };
		})();
		this.inFlight.set(key, work);
		work.then(
			() => this.inFlight.delete(key),
			() => this.inFlight.delete(key)
		);
		return work;
	}
}
