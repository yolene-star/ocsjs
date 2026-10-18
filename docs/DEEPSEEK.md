# DeepSeek 与本地题库定制版

当前版本：`5.2.1-deepseek.3`。增强智慧树纯文字单选、多选和判断选择题，以及 `wisdom-mooc.zhihuishu.com` 的 AI 随堂练习。

## 配置与使用

1. 安装构建生成的 `dist/ocs.user.js`，替换原版，避免同时启用两份 OCS。
2. 在需要桌面辅助的页面，使用 OCS 桌面端启动的浏览器。
3. 在“知到智慧树 → 自动学习 → DeepSeek 随堂练习”中填写官方 API Key 和账号可用的模型名称，或通过“导入配置文件”导入本机 JSON 文件。
4. 点击“测试连接”；测试会产生一次 API 调用。随堂练习需要另外开启该处的“自动选择并提交”开关。
5. 在“通用 → 全局设置”中开启“题库优先，未命中使用 DeepSeek（智慧树）”。通用答题器沿用原来的答案提交方式设置。

本机配置文件格式如下。不要将真实密钥提交到仓库或分享给其他人；文件名 `deepseek.local.json` 已加入忽略规则。

```json
{
  "apiKey": "在本机填写自己的 Key",
  "model": "deepseek-flash"
}
```

密钥保存在当前脚本管理器存储中，以密码输入框显示，并排除 OCS 桌面端配置同步。密钥不会写入构建产物，也不会包含在本地题库导出中。接口地址固定为 DeepSeek 官方 API。

## 查询和更新顺序

本地题库 → 已配置且启用的在线题库 → 未命中或题库不可用时调用 DeepSeek → 保存本地答案。

- 在线题库必须在原有“题库配置”入口填写服务提供方的标准 OCS 配置。该入口没有预置题库，不能在这里填写 DeepSeek Key。没有在线题库配置时会跳过这一阶段。
- 题库匹配使用题干、题型和选项集合，保存答案文本，选项换序后重新映射位置。
- API 与在线题库答案按“未核验”保存。随堂练习明确公布正确答案后，优先更新为“已核验”；未核验答案不会覆盖已核验答案。
- 本地题库独立于原版 200 题缓存，持久保存在当前脚本管理器中，最多 5000 题。在“管理本地题库”中查看、导入和导出 JSON。它不会自动改写电脑上的 JSON 文件。
- API 失败、返回无效选项、页面状态变化或用户手动介入时，不会回退随机提交。图片题和其他未支持题型保持原题库流程，不使用此处的 DeepSeek 回退。

模型与题库答案不保证正确。API 调用按自己的 DeepSeek 账号规则计费；清理脚本存储或卸载前，请导出题库备份。

## 构建与测试

依赖版本按 `pnpm-lock.yaml` 安装，项目发布流程使用 pnpm 10.30.3。准备输出路径：

```powershell
pnpm install --frozen-lockfile
Set-Content packages/core/.env 'VITE_BUILD_PATH="../../dist"'
Set-Content packages/scripts/.env 'VITE_BUILD_PATH="../../dist"'
pnpm exec tsc -p packages/utils
npm run build
```

运行原有算法测试和新增的题库/API/交互测试：

```powershell
npm test
npm run test:deepseek
```

新增测试使用模拟网络和 DOM，不会使用本机密钥调用真实服务。真实课程页面、在线题库账号和 API 余额应在安装后通过“测试连接”及实际页面反馈确认。

参考资料：[DeepSeek JSON 输出](https://api-docs.deepseek.com/guides/json_mode/)、[OCS 题库配置教程](https://docs.ocsjs.com/docs/work)。
