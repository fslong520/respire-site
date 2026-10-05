"use client";

import { useCallback, useState } from "react";
import { AlertTriangle, Check, Copy, ShieldCheck, Terminal } from "lucide-react";

export const AI_INSTALL_PROMPT = `帮我装 respire 记忆（npm 包 @rsrsai/cli，命令 rsrs），开通在线同步并当场验证能用：

1. npm i -g @rsrsai/cli
2. rsrs doctor --fix
3. rsrs register
   交互式：要用户名、登录密码（≥8 位）、超级密码，都在终端里问我，别写进命令行。
   完成后把 super password 原样给我，等我回「已记好」再往下走。
4. rsrs inject --all
5. rsrs remember "安装测试条目" && rsrs sync && rsrs recall "安装测试条目" --titles
6. rsrs doctor --remote（fail 必须是 0，Remote 要 PASS）

哪一步失败就停下，把报错原文给我，别自己猜参数或服务器地址。`;

type CopyState = "idle" | "copied" | "manual";

function CopyPrompt() {
  const [state, setState] = useState<CopyState>("idle");

  const copy = useCallback(async () => {
    const settle = (next: CopyState, ms = 2400) => {
      setState(next);
      window.setTimeout(() => setState("idle"), ms);
    };

    try {
      await navigator.clipboard.writeText(AI_INSTALL_PROMPT);
      settle("copied");
      return;
    } catch {
      // fall through to the legacy selection copy
    }

    const area = document.createElement("textarea");
    area.value = AI_INSTALL_PROMPT;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(area);
    settle(ok ? "copied" : "manual", ok ? 2400 : 4000);
  }, []);

  return (
    <button
      type="button"
      className={`prompt-copy is-${state}`}
      onClick={copy}
    >
      {state === "copied" ? (
        <Check size={17} strokeWidth={2.6} />
      ) : state === "manual" ? (
        <AlertTriangle size={17} strokeWidth={2.4} />
      ) : (
        <Copy size={17} />
      )}
      {state === "copied"
        ? "已复制 · 粘给任意 AI"
        : state === "manual"
          ? "请手动全选上方文本复制"
          : "复制这段 · 让 AI 帮你装"}
    </button>
  );
}

export function AiInstallCard() {
  return (
    <div className="prompt-card">
      <div className="prompt-card-head">
        <span className="prompt-card-title">
          <Terminal size={16} strokeWidth={2.2} />
          一键安装配置 · to AI
        </span>
        <span className="prompt-card-badge">
          <ShieldCheck size={13} strokeWidth={2.4} />
          干净环境实测通过 · 直连 rsrs 云
        </span>
      </div>

      <pre className="prompt-body">
        <code>{AI_INSTALL_PROMPT}</code>
      </pre>

      <div className="prompt-card-foot">
        <CopyPrompt />
        <span className="prompt-card-note">
          复制后粘进任意 AI 对话框，它会自己装、自己测，报错原文交回给你。
        </span>
      </div>
    </div>
  );
}
