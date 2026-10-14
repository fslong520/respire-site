// Local preview: synthetic fixture API and memory vault for Vite development.
// Usage: node local-preview.mjs. Data is ephemeral and reset on restart.
// Development helper only; never included in the browser bundle.
import assert from 'node:assert/strict';
import { generateSecretKey, unwrapUrk, wrapVaultV4, deriveDataKey, encryptItem } from './src/crypto.js';
import { FIXTURE, startFixtureApi } from './tests/fixture-api.mjs';

// Allow the usual loopback Vite development origins.
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174', 'http://127.0.0.1:5175'];

const api = await startFixtureApi();
for (const origin of DEV_ORIGINS) api.origins.add(origin);
const seedOrigin = DEV_ORIGINS[3]; // Use an allowed origin for synthetic seeding.

const recovery = generateSecretKey();
const wrapped = await wrapVaultV4(recovery);
const vaultReply = await fetch(`${api.origin}/api/self/vault`, {
  method: 'POST',
  headers: { authorization: `Bearer ${FIXTURE.userToken}`, 'content-type': 'application/json', origin: seedOrigin },
  body: JSON.stringify(wrapped),
});
assert.equal(vaultReply.status, 200, 'vault create failed');
const dataKey = await deriveDataKey(await unwrapUrk(recovery, '', wrapped));

let pushed = 0;
async function remember(id, parent_id, kind, title, content, importance = 'important') {
  const now = '2026-10-08T09:00:00Z';
  const { nonce, ciphertext } = await encryptItem(dataKey, JSON.stringify({
    id, parent_id, kind, title, content, importance, tags: [], project: '',
    user: FIXTURE.user, computer: 'preview', device: 'preview', modified_by: 'preview',
    emotion: -1, created_at: now, updated_at: now,
  }));
  const reply = await fetch(`${api.origin}/push`, {
    method: 'POST',
    headers: { authorization: `Bearer ${FIXTURE.userToken}`, 'content-type': 'application/json', origin: seedOrigin },
    body: JSON.stringify({ id, ciphertext, nonce, embedding_enc: '', updated_at: now, deleted: false }),
  });
  assert.equal(reply.status, 200, `push ${id} failed`);
  pushed++;
}

const M = [
  // Synthetic project cluster.
  ['risense', '', 'context', 'risense 项目', '【前因】团队要做一个 AI 记忆方向的新项目。【行为】立项并拆分前端、服务、CLI 三条线。【后果】仓库名 risense，记忆页是其门面。'],
  ['risense-bg', 'risense', 'context', '项目背景与边界', '只做记忆的存取与呈现，不做模型推理；推理交给接入方。'],
  ['risense-e2ee', 'risense-bg', 'decision', '采用端到端加密架构', '【前因】记忆属个人隐私。【行为】服务端只存密文，密钥由用户持有。【后果】服务端无法检索明文，embedding 在 CLI 侧生成。'],
  ['risense-urk', 'risense-e2ee', 'decision', 'URK 包装方案 v4', '超级密码经 Argon2 派生包装 URK，再解出数据密钥；v3 修复了无 Secret Key 的恢复路径。'],
  ['risense-kdf', 'risense-urk', 'context', '密钥派生细节', 'PBKDF2-SHA256 十万轮做登录口令哈希；HKDF-SHA256 派生认证盐。'],
  ['risense-sync', 'risense', 'task', '同步通道改造', '【前因】全量拉取太重。【行为】引入 cursor 增量同步与墓碑删除。【后果】弱网下也能秒级收敛。'],
  ['risense-sync-ci', 'risense-sync', 'task', '补齐增量同步回归', ' fixture API 上覆盖 snapshot=0 增量路径。'],
  ['risense-views', 'risense', 'context', '记忆页四视图', '树看层级、列表看字段、卡片看概览、图谱看关联。'],
  ['risense-views-tree', 'risense-views', 'context', '树视图：懒加载展开', 'buildIndex O(n) 建索引，展开时 childrenOf 按需取子行。'],
  ['risense-views-list', 'risense-views', 'context', '列表视图：分页与列裁剪', '每页 24 条；窄屏只留类型/标题/箭头三列。'],
  ['risense-views-card', 'risense-views', 'context', '卡片视图：按类型淡染', 'data-kind 映射 --card-accent 七色板，整卡 10% 混色。'],
  ['risense-views-graph', 'risense-views', 'task', '图谱视图：parent_id 关系网', '【前因】三视图回答不了“哪些记忆彼此关联”。【行为】手写 force 布局 + SVG，收敛后停帧。【后果】图谱视图落地，本次预览的主角。'],
  ['risense-views-graph-fit', 'risense-views-graph', 'task', '收敛后自动适配视口', '布局稳定后一次性 fit 整图；用户拖拽/缩放后交还控制权。'],
  ['risense-views-graph-dim', 'risense-views-graph', 'task', '悬停一跳邻居高亮', '建图时预计算邻接表，非邻居透明度降到 0.15。'],
  ['risense-di', 'risense', 'decision', '零运行时依赖原则', '【前因】singlefile 构建对体积敏感。【行为】force 布局手写不引 d3。【后果】单文件 gzip 维持在 200KB 内。'],
  ['risense-rel', 'risense', 'context', '发版节奏', '每两周一个 patch 版本，follow semver。'],
  // Synthetic product cluster.
  ['product', '', 'context', 'respire 产品', '一句话：一份记忆，处处可用。'],
  ['product-brand', 'product', 'context', '品牌语言', '衬线大标题 + 等宽脚注 + 纸面底色，克制不加戏。'],
  ['product-serif', 'product-brand', 'context', 'Fraunces + 思源宋体标题体系', '西文 Fraunces Variable，中文 Noto Serif SC；正文 Work Sans + PingFang。'],
  ['product-paper', 'product-brand', 'preference', '纸面配色方向', '暖纸底 --bg #f8f6f2，侧栏与页面同色，读起来像一本笔记本。'],
  ['product-launch', 'product', 'task', 'v0.3 发布清单', '图谱视图、增量同步、管理员统计三件套。'],
  ['product-launch-site', 'product-launch', 'task', '官网同步更新', 'rsrs.rs 首页补图谱视图截图。'],
  ['product-launch-doc', 'product-launch', 'task', '文档补图谱一节', '说明 parent_id 边与日记过滤规则。'],
  // Synthetic preference cluster.
  ['prefs', '', 'preference', '个人偏好', '与人协作、与工具相处的方式。'],
  ['prefs-comm', 'prefs', 'preference', '沟通偏好', '结论先行，解释靠后；不铺垫不寒暄。'],
  ['prefs-tools', 'prefs', 'preference', '工具链偏好', '顺手为主，不追新。'],
  ['prefs-rust', 'prefs-tools', 'skill', 'Rust', '能写服务与 CLI，熟悉借用检查与生命周期的心智模型。'],
  ['prefs-rails', 'prefs-tools', 'skill', 'Ruby on Rails', '约定优于配置，MVC 与 concern 的熟手。'],
  ['prefs-vite', 'prefs-tools', 'skill', 'Vite', '插件机制、env 注入与 singlefile 构建都趟过坑。'],
  // Synthetic technology cluster.
  ['radar', '', 'context', '技术雷达', '持续关注的方向。'],
  ['radar-local', 'radar', 'context', '本地优先软件', '数据与计算尽量留在用户设备上。'],
  ['radar-e2ee', 'radar', 'context', '端到端加密实践', '密钥恢复、多设备同步、可审计性是三道坎。'],
  ['radar-graph', 'radar', 'context', '关系图谱可视化', 'Obsidian 的图谱证明了关联浏览的价值。'],
  // Synthetic family/time cluster.
  ['family', '', 'preference', '家庭', '重要的日期与人。'],
  ['family-bd', 'family', 'time', '家人生日', '三月与十一月各一位，提前一周准备礼物。'],
  ['family-anniv', 'family', 'time', '结婚纪念日', '每年五月二十日，订同一家餐厅。'],
  ['family-weekend', 'family', 'task', '周末家庭日', '不带电脑，只带相机。'],
  // Synthetic emotion cluster.
  ['mood', '', 'emotion', '近期状态', '记录节律，防止透支。'],
  ['mood-week', 'mood', 'emotion', '本周精力', '【前因】连续加班三天。【行为】主动砍掉晚间安排。【后果】周四恢复手感。'],
  // Dangling parents remain visible as standalone nodes.
  ['orphan-old', 'deleted-long-ago', 'context', '迁移遗留的旧笔记', '父节点已删，这条成了没根的孩子——图谱里会以孤点呈现。'],
  ['orphan-idea', 'future-project-x', 'task', '尚未立项的点子', '父引用指向一个还不存在的项目占位。'],
];

for (const [id, parent, kind, title, content] of M) await remember(id, parent, kind, title, content);

// Trivial synthetic diary entries are omitted from the graph.
const days = ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
for (const day of days) {
  await remember(
    `diary-${day}`, 'risense-views-graph', 'context', `活动轨迹 ${day}`,
    `【前因】常规一天。【行为】在 ${day} 处理了若干事项并记录轨迹。【后果】留档备查。`, 'trivial',
  );
}

console.log('');
console.log('════════════ respire 本地预览已就绪 ════════════');
console.log(`API:        ${api.origin}  (fixture，内存态)`);
console.log(`页面:       http://localhost:5173/dashboard   (vite dev 未启动时先运行: VITE_API_BASE_URL=${api.origin} npm run dev)`);
console.log(`登录:       用户名 ${FIXTURE.user} / 密码 ${FIXTURE.password}`);
console.log(`解锁码:     ${recovery}`);
console.log(`数据:       ${pushed} 条（其中 ${days.length} 条 trivial 日记，图谱不显示）`);
console.log('════════════════════════════════════════════════');
console.log('');
