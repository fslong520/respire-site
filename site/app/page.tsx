import {
  ArrowDown,
  ArrowRight,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleCheck,
  Cloud,
  Code2,
  KeyRound,
  Laptop,
  LockKeyhole,
  LogIn,
  Menu,
  ShieldCheck,
  Smartphone,
  Sparkles,
  WandSparkles,
} from "lucide-react";

const agents = [
  { name: "Codex", short: "Cx", tone: "blue" },
  { name: "Claude Code", short: "Cl", tone: "coral" },
  { name: "Pi Agent", short: "Pi", tone: "violet" },
  { name: "Zig Code", short: "Zg", tone: "amber" },
  { name: "DeepSeek Harness", short: "Ds", tone: "cyan" },
  { name: "WorkBuddy", short: "Wb", tone: "green" },
  { name: "千问助手", short: "千", tone: "red" },
];

const memories = [
  { title: "代码审查方式", meta: "个人 · 12 条规则", icon: Code2 },
  { title: "产品研发项目", meta: "工作 · 8 个技能", icon: Sparkles },
  { title: "写作与排版偏好", meta: "个人 · 刚刚更新", icon: WandSparkles },
];

function Logo({ inverse = false }: { inverse?: boolean }) {
  return (
    <a className="brand" href="#top" aria-label="respire 首页">
      <img
        className="brand-logo"
        src={inverse ? "/brand/respire-logo-reverse.svg" : "/brand/respire-logo-dark.svg"}
        width="733"
        height="128"
        alt="Respire"
      />
    </a>
  );
}

function AgentBadge({
  name,
  short,
  tone,
}: {
  name: string;
  short: string;
  tone: string;
}) {
  return (
    <div className="agent-badge">
      <span className={`agent-icon ${tone}`}>{short}</span>
      <span>{name}</span>
      <Check size={16} strokeWidth={2.4} aria-hidden="true" />
    </div>
  );
}

function MemoryApp() {
  return (
    <div className="memory-stage" aria-label="respire 产品界面示意">
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <div className="stage-glow" />
      <div className="app-window">
        <div className="app-topbar">
          <div className="app-mini-brand">
            <img
              src="/brand/respire-logo-dark.svg"
              width="733"
              height="128"
              alt="Respire"
            />
          </div>
          <div className="secure-state">
            <LockKeyhole size={13} />
            端到端加密
          </div>
        </div>

        <div className="app-body">
          <aside className="app-sidebar">
            <div className="sidebar-control active">
              <BrainCircuit size={17} />
              全部记忆
            </div>
            <div className="sidebar-control">
              <Sparkles size={17} />
              Skills
            </div>
            <div className="sidebar-control">
              <Laptop size={17} />
              设备
            </div>
            <div className="sidebar-spacer" />
            <div className="sidebar-vault">
              <span className="vault-dot" />
              个人保险库
              <span>24</span>
            </div>
            <div className="sidebar-vault">
              <span className="vault-dot work" />
              工作保险库
              <span>17</span>
            </div>
          </aside>

          <div className="memory-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-eyebrow">MEMORY CLOUD</span>
                <h3>今天想教 AI 什么？</h3>
              </div>
              <button className="round-add" aria-label="添加记忆">+</button>
            </div>

            <div className="learn-card">
              <div className="learn-orb">
                <span />
                <span />
                <span />
              </div>
              <div className="learn-copy">
                <strong>正在学习你的工作方式</strong>
                <p>把规则、示例或整个项目丢给我。</p>
              </div>
              <div className="learning-pill">学习中</div>
            </div>

            <div className="memory-list">
              {memories.map((memory) => {
                const Icon = memory.icon;
                return (
                  <div className="memory-row" key={memory.title}>
                    <span className="memory-row-icon"><Icon size={17} /></span>
                    <div>
                      <strong>{memory.title}</strong>
                      <span>{memory.meta}</span>
                    </div>
                    <ChevronRight size={17} />
                  </div>
                );
              })}
            </div>

            <div className="sync-card">
              <div className="sync-title">
                <Cloud size={16} />
                已同步到所有智能体
              </div>
              <div className="sync-agents" aria-label="已同步智能体">
                {agents.slice(0, 5).map((agent) => (
                  <span className={`agent-icon ${agent.tone}`} key={agent.name}>{agent.short}</span>
                ))}
                <span className="agent-more">+2</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="floating-note note-home">
        <span className="device-chip"><Smartphone size={16} /></span>
        <span><small>家里的电脑</small><strong>已学会</strong></span>
        <CircleCheck size={18} />
      </div>
      <div className="floating-note note-work">
        <span className="device-chip"><Laptop size={16} /></span>
        <span><small>公司的电脑</small><strong>已注入</strong></span>
        <CircleCheck size={18} />
      </div>
    </div>
  );
}

function KeyNode({
  label,
  detail,
  className = "",
}: {
  label: string;
  detail?: string;
  className?: string;
}) {
  return (
    <div className={`key-node ${className}`}>
      <KeyRound size={17} />
      <span><strong>{label}</strong>{detail && <small>{detail}</small>}</span>
    </div>
  );
}

export default function Home() {
  return (
    <main id="top">
      <section className="hero-shell">
        <nav className="nav-wrap" aria-label="主导航">
          <Logo inverse />
          <div className="nav-links">
            <a href="#product">产品</a>
            <a href="#how">工作原理</a>
            <a href="#integrations">兼容工具</a>
            <a href="#security">安全</a>
          </div>
          <div className="nav-actions">
            <a className="nav-login" href="https://github.com/risense-ai/respire-docs">文档</a>
            <a className="nav-login" href="https://github.com/risense-ai/respire-cli">GitHub</a>
            <a className="button button-small button-light-outline" href="https://dash.rsrs.rs">
              <LogIn size={15} /> 登录
            </a>
            <a className="button button-small button-light" href="#download">
              下载客户端 <ArrowRight size={15} />
            </a>
          </div>
          <details className="mobile-nav">
            <summary aria-label="打开菜单"><Menu /></summary>
            <div className="mobile-nav-popover">
              <a href="#product">产品</a>
              <a href="#how">工作原理</a>
              <a href="#integrations">兼容工具</a>
              <a href="#security">安全</a>
              <a href="https://dash.rsrs.rs">登录</a>
              <a href="#download">下载客户端 <ArrowRight size={14} /></a>
            </div>
          </details>
        </nav>

        <div className="hero-grid">
          <div className="hero-copy">
            <div className="announcement">
              <span>NEW</span>
              你的第一个 AI 记忆云
              <ChevronRight size={15} />
            </div>
            <h1>
              教一次，
              <span>每个 AI 都记得。</span>
            </h1>
            <p className="hero-lead">
              respire 把你教给 AI 的规则、技能与项目上下文，变成可加密、可同步、可注入的 Skill。换电脑、换模型、换智能体，都不必从头再来。
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="#download">
                下载客户端 <ArrowRight size={18} />
              </a>
              <a className="text-link" href="#how">
                看它如何工作 <span>↓</span>
              </a>
            </div>
            <div className="hero-proof">
              <span><ShieldCheck size={17} /> 端到端加密</span>
              <span><Cloud size={17} /> 跨设备同步</span>
              <span><Code2 size={17} /> Skill 即插即用</span>
            </div>
          </div>
          <MemoryApp />
        </div>
        <div className="hero-fade" />
      </section>

      <section className="agent-strip" id="integrations">
        <p>一份记忆，随你进入每一个智能体</p>
        <div className="agent-marquee">
          {agents.map((agent) => <AgentBadge {...agent} key={agent.name} />)}
        </div>
      </section>

      <section className="problem-section" id="product">
        <div className="section-heading centered">
          <span className="kicker">WHY respire</span>
          <h2>AI 越来越聪明，<br />却总不记得你。</h2>
          <p>你真正花时间教会的，不该被锁在某一次对话、某一台电脑、某一个模型里。</p>
        </div>

        <div className="problem-grid">
          <article className="problem-card card-home">
            <div className="card-label"><span>01</span> 重复教学</div>
            <div className="device-scene">
              <div className="scene-device home-device">
                <Smartphone size={22} />
                <span>家里</span>
                <i className="state-ok"><Check size={12} /></i>
              </div>
              <div className="broken-link"><span /><i>?</i><span /></div>
              <div className="scene-device work-device">
                <Laptop size={22} />
                <span>公司</span>
                <i className="state-empty">×</i>
              </div>
            </div>
            <h3>在家教过一遍，<br />到公司还要再教一遍。</h3>
            <p>偏好、背景、做事方法散落在不同设备和会话里。你不是在用 AI，而是在反复培训 AI。</p>
          </article>

          <article className="problem-card card-config">
            <div className="card-label"><span>02</span> 配置摩擦</div>
            <div className="terminal-scene">
              <div className="terminal-top"><i /><i /><i /><span>terminal</span></div>
              <code><b>$</b> cp rules.md ~/.agent/</code>
              <code><b>$</b> edit config.yaml</code>
              <code><b>$</b> wire mcp + hooks + env</code>
              <code className="terminal-error">error: context not found</code>
            </div>
            <h3>要么太硬核，<br />要么要折腾一大堆。</h3>
            <p>规则文件、钩子、环境变量、插件、提示词，每个工具各配一遍。没有真正开箱即用的记忆层。</p>
          </article>

          <article className="problem-card card-fragment">
            <div className="card-label"><span>03</span> 记忆碎片</div>
            <div className="fragment-scene">
              <span className="fragment f-one">写作偏好</span>
              <span className="fragment f-two">项目背景</span>
              <span className="fragment f-three">代码规范</span>
              <span className="fragment f-four">常用流程</span>
              <div className="fragment-core"><BrainCircuit size={27} /></div>
            </div>
            <h3>有用的记忆很多，<br />能带走的却很少。</h3>
            <p>对话中的纠正和经验很快沉底。换一个工具，积累就归零；换一台设备，又从陌生人开始。</p>
          </article>
        </div>
      </section>

      <section className="solution-section" id="how">
        <div className="solution-wrap">
          <div className="section-heading light-heading">
            <span className="kicker light">HOW IT WORKS</span>
            <h2>把记忆变成<br />AI 可以带走的能力。</h2>
            <p>不再管理一堆配置。你只管教，respire 负责整理、加密、同步与注入。</p>
          </div>

          <div className="steps-stack">
            <article className="step-card">
              <div className="step-num">1</div>
              <div className="step-icon learn"><BrainCircuit /></div>
              <div className="step-copy">
                <span>LEARN</span>
                <h3>像平时一样，把事情丢给 AI。</h3>
                <p>给它规则、示例、文档或一次纠正。respire 自动提炼可复用的偏好、知识与工作方法。</p>
              </div>
              <div className="step-demo learn-demo">
                <div className="message user-message">以后写报告，先给结论，英文术语首次出现再保留原文。</div>
                <div className="message ai-message"><Sparkles size={14} /> 已整理为「写作与排版偏好」</div>
              </div>
            </article>

            <article className="step-card">
              <div className="step-num">2</div>
              <div className="step-icon seal"><LockKeyhole /></div>
              <div className="step-copy">
                <span>SEAL</span>
                <h3>封装成你的私人 Skill。</h3>
                <p>记忆按个人、工作和项目分入不同保险库；在可信设备本地加密，云端只同步密文。</p>
              </div>
              <div className="step-demo skill-demo">
                <div className="skill-file">
                  <div className="skill-file-icon">S</div>
                  <div><strong>reporting-style.skill</strong><span>8 rules · encrypted</span></div>
                  <ShieldCheck size={18} />
                </div>
              </div>
            </article>

            <article className="step-card">
              <div className="step-num">3</div>
              <div className="step-icon inject"><Cloud /></div>
              <div className="step-copy">
                <span>INJECT</span>
                <h3>打开任何智能体，马上接着做。</h3>
                <p>respire 把正确的记忆注入正确的智能体。换设备、换模型，也保留同一套做事方式。</p>
              </div>
              <div className="step-demo inject-demo">
                {agents.slice(0, 4).map((agent, index) => (
                  <div className="inject-row" key={agent.name}>
                    <span className={`agent-icon ${agent.tone}`}>{agent.short}</span>
                    <span>{agent.name}</span>
                    <i style={{ animationDelay: `${index * 0.35}s` }} />
                    <Check size={15} />
                  </div>
                ))}
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="everywhere-section">
        <div className="everywhere-copy">
          <span className="kicker">ONE MEMORY. EVERYWHERE.</span>
          <h2>家里学会的，<br />公司电脑直接会。</h2>
          <p>新电脑不用重建配置，新智能体不用从零磨合。你的记忆云持续同步，但每个项目仍有清晰边界。</p>
          <ul>
            <li><CircleCheck /> 个人偏好跨设备跟随</li>
            <li><CircleCheck /> 项目知识按需注入</li>
            <li><CircleCheck /> 技能升级一次，全端生效</li>
          </ul>
        </div>

        <div className="device-network" aria-label="跨设备记忆同步示意">
          <div className="network-glow" />
          <div className="network-line line-a" />
          <div className="network-line line-b" />
          <div className="network-device network-home">
            <span className="network-device-icon"><Smartphone /></span>
            <div><small>HOME</small><strong>家里的电脑</strong><em>3 个新记忆</em></div>
          </div>
          <div className="network-core">
            <span className="core-ring"><BrainCircuit /></span>
            <small>YOUR</small>
            <strong>respire</strong>
            <em><LockKeyhole size={12} /> Encrypted</em>
          </div>
          <div className="network-device network-work">
            <span className="network-device-icon"><Laptop /></span>
            <div><small>WORK</small><strong>公司的电脑</strong><em><Check size={12} /> 已同步</em></div>
          </div>
          <div className="network-skill">
            <Code2 size={19} />
            <div><strong>Skill injected</strong><span>project-memory.skill</span></div>
            <span className="pulse-dot" />
          </div>
        </div>
      </section>

      <section className="integrations-section">
        <div className="section-heading centered">
          <span className="kicker">BUILT TO MOVE</span>
          <h2>不站队任何模型。<br />只站在你这边。</h2>
          <p>记忆属于你，不属于某个平台。今天用 Codex，明天用 Claude Code，后天出现新的智能体——你的积累都能继续。</p>
        </div>
        <div className="integration-grid">
          {agents.map((agent) => (
            <article className="integration-card" key={agent.name}>
              <span className={`agent-icon large ${agent.tone}`}>{agent.short}</span>
              <div><strong>{agent.name}</strong><span>首发支持</span></div>
              <CircleCheck size={19} />
            </article>
          ))}
          <article className="integration-card more-card">
            <span className="agent-icon large neutral">+∞</span>
            <div><strong>更多智能体</strong><span>开放适配协议</span></div>
            <ArrowRight size={19} />
          </article>
        </div>
      </section>

      <section className="security-section" id="security">
        <div className="security-wrap">
          <div className="security-copy">
            <div className="security-icon"><ShieldCheck /></div>
            <span className="kicker light">SECURITY BY ARCHITECTURE</span>
            <h2>我们的云，<br />看不到你的记忆。</h2>
            <p>解密发生在你的可信设备上。服务器保存加密后的数据和被包裹的密钥，不保存用户密码、账户秘密或明文根密钥。</p>
            <div className="security-points">
              <span><Check /> 明文只在本地可信环境出现</span>
              <span><Check /> 每个保险库、每个项目独立密钥</span>
              <span><Check /> 换密码只需重新包裹根密钥</span>
            </div>
          </div>

          <div className="key-map" aria-label="respire 端到端加密密钥层级">
            <div className="key-map-top">
              <KeyNode label="用户密码" className="input-key" />
              <span className="plus-sign">+</span>
              <KeyNode label="Account Secret" className="input-key" />
              <span className="plus-sign">+</span>
              <KeyNode label="设备密钥" className="input-key" />
            </div>
            <ArrowDown className="map-arrow" />
            <KeyNode label="账户解锁密钥" detail="KEK · 只负责加密 / 解密" className="kek-key" />
            <ArrowDown className="map-arrow" />
            <KeyNode label="用户根密钥" detail="URK · 随机生成" className="root-key" />
            <div className="branch-line"><i /><i /><i /></div>
            <div className="vault-row">
              <div>
                <KeyNode label="个人保险库密钥" className="vault-key" />
                <div className="project-row"><span>偏好键</span><span>写作键</span></div>
              </div>
              <div>
                <KeyNode label="工作保险库密钥" className="vault-key" />
                <div className="project-row"><span>项目键 A</span><span>项目键 B</span></div>
              </div>
            </div>
            <ArrowDown className="map-arrow bottom-arrow" />
            <div className="cipher-box">
              <LockKeyhole size={18} />
              <span><strong>用户真实数据 · Ciphertext</strong><small>服务器只能看到密文</small></span>
            </div>
          </div>
        </div>
      </section>

      <section className="final-cta" id="download">
        <div className="cta-orbit cta-orbit-one" />
        <div className="cta-orbit cta-orbit-two" />
        <div className="cta-logo" aria-label="respire">
          <img
            className="cta-logo-image"
            src="/brand/respire-logo-reverse.svg"
            width="733"
            height="128"
            alt="Respire"
          />
        </div>
        <span className="kicker light">YOUR AI, YOUR MEMORY</span>
        <h2>让 AI 从此真正认识你。</h2>
        <p>一次教会，安全保存，到处可用。客户端与 CLI 现已开放下载。</p>
        <div className="cta-actions">
          <a className="button button-primary button-white" href="https://github.com/risense-ai/respire-releases/releases">
            查看私有交付通道 <ArrowRight size={18} />
          </a>
          <a className="button button-light-outline" href="https://github.com/risense-ai/respire-docs">
            阅读文档
          </a>
        </div>
        <div className="cta-install">
          <code>npm i -g @rsrsai/cli<br />pnpm add -g @rsrsai/cli</code>
        </div>
        <span>Respire · 私有预览 · 未来获批发布后可使用包命令，本轮未发布 npm 包</span>
      </section>

      <footer>
        <div className="footer-top">
          <Logo />
          <p>为你的所有 AI，保存同一份你。</p>
          <div className="footer-links">
            <a href="#product">产品</a>
            <a href="#integrations">兼容工具</a>
            <a href="#security">安全</a>
            <a href="https://github.com/risense-ai/respire-docs">文档</a>
            <a href="https://dash.rsrs.rs">登录</a>
            <a href="https://github.com/risense-ai/respire-cli">GitHub</a>
            <a href="mailto:hello@Respire">联系我们</a>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© 2026 respire. All rights reserved.</span>
          <span>Encrypted by design · Owned by you</span>
        </div>
      </footer>
    </main>
  );
}
