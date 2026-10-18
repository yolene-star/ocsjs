import { defaultAnswerWrapperHandler } from '@ocsjs/core';
import type { AnswererWrapper, SearchInformation } from '@ocsjs/core';
import { h, $modal, $message } from 'easy-us';
import { CommonProject } from '../projects/common';
import { ZHSProject } from '../projects/zhs';
import { requestDeepSeek } from './deepseek-quiz';
import {
	createBrowserQuestionBank,
	HybridAnswerer,
	matchChoiceAnswer,
	readPublishedAnswer,
	choiceOptionTexts
} from './hybrid-answerer';
import { pickOnlineAnswer } from './hybrid-answerer';
import type { BankQuestion } from './hybrid-answerer';

const bank = createBrowserQuestionBank();
const hybrid = new HybridAnswerer(bank);

export function isHybridEnabled(): boolean {
	return /(^|\.)zhihuishu\.com$/i.test(location.hostname) && CommonProject.scripts.settings.cfg.hybridEnabled === true;
}

export function hasHybridAnswerSource(): boolean {
	if (!isHybridEnabled()) return false;
	const cfg = ZHSProject.scripts['study-center'].cfg;
	return !!String(cfg.deepseekApiKey || '').trim() || bank.entries().length > 0;
}

export async function searchHybridQuestion(
	question: BankQuestion,
	wrappers?: AnswererWrapper[]
): Promise<SearchInformation[]> {
	const cfg = ZHSProject.scripts['study-center'].cfg;
	const enabledWrappers = wrappers || CommonProject.scripts.settings.methods.getWorkOptions().answererWrappers;
	const result = await hybrid.answer(
		question,
		async () => {
			if (!enabledWrappers.length) return;
			const infos = await defaultAnswerWrapperHandler(enabledWrappers, {
				title: question.title,
				type: question.kind || (question.multiple ? 'multiple' : 'single'),
				options: question.options.join('\n')
			});
			return pickOnlineAnswer(infos, question);
		},
		() =>
			requestDeepSeek(question, {
				enabled: true,
				apiKey: String(cfg.deepseekApiKey || ''),
				model: String(cfg.deepseekModel || '')
			})
	);
	$message.info({ content: `答案来源：${result.source}${result.verified ? '（已核验）' : '（未核验）'}`, duration: 5 });
	return [
		{
			name: result.source,
			results: [
				{
					question: question.title,
					answer: result.indices.map((i) => choiceOptionTexts(question)[i]).join('#'),
					extra_data: {
						ai: /DeepSeek/.test(result.source),
						cache: result.source.startsWith('本地题库'),
						verified: result.verified
					}
				}
			]
		}
	];
}

export async function searchHybridQuizIndices(question: BankQuestion): Promise<number[]> {
	if (!isHybridEnabled()) {
		const cfg = ZHSProject.scripts['study-center'].cfg;
		return requestDeepSeek(question, {
			enabled: true,
			apiKey: String(cfg.deepseekApiKey || ''),
			model: String(cfg.deepseekModel || '')
		});
	}
	const infos = await searchHybridQuestion(question);
	const indices = matchChoiceAnswer(infos[0].results[0].answer, question);
	if (!indices) throw new Error('无法匹配题库答案，已停止提交。');
	return indices;
}

export function updateBankFromQuizFeedback(question: BankQuestion, root: HTMLElement): void {
	if (!isHybridEnabled()) return;
	const correct = readPublishedAnswer(root.textContent || '', question);
	if (correct) bank.put(question, correct, '平台公布正确答案', true);
}

export function showHybridBank(): void {
	const entries = bank.entries();
	const count = h('p', `本地题库：${entries.length} 题。最多保存 5000 题；保存在当前浏览器的脚本存储中。`);
	const exportButton = h('button', { className: 'base-style-button-secondary' }, '导出本地题库');
	exportButton.onclick = () => {
		const url = URL.createObjectURL(new Blob([bank.export()], { type: 'application/json;charset=utf-8' }));
		const link = h('a', { href: url, download: 'ocs-local-question-bank.json' });
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 10000);
	};
	const importButton = h('button', { className: 'base-style-button-secondary' }, '导入本地题库');
	importButton.onclick = () => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json,application/json';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				if (file.size > 4 * 1024 * 1024) throw new Error('题库文件超过 4 MB，请分批导入。');
				const added = bank.import(await file.text());
				count.textContent = `导入处理 ${added} 条记录，本地现有 ${
					bank.entries().length
				} 题。重新打开面板可查看最新列表。`;
				$message.success('题库已合并；未核验的答案不会覆盖已核验答案。');
			} catch (error) {
				$message.error((error as Error).message);
			}
		};
		input.click();
	};
	$modal.simple({
		width: 720,
		content: h('div', [
			count,
			h(
				'p',
				'查询顺序：本地题库 → 已启用的在线题库 → DeepSeek。API 和在线题库答案按未核验保存；随堂练习公布正确答案后优先更新。当前增强支持智慧树纯文字选择题。'
			),
			h('div', [exportButton, importButton]),
			...entries
				.slice(0, 50)
				.map((entry) =>
					h('div', { style: { padding: '8px', borderBottom: '1px solid #ddd' } }, [
						h('div', entry.question.title),
						h(
							'div',
							`答案：${entry.answers.join('；')}　来源：${entry.source}　${entry.verified ? '已核验' : '未核验'}`
						)
					])
				),
			h('p', entries.length > 50 ? '此处仅显示最近 50 题，导出文件包含全部记录。' : '')
		])
	});
}
