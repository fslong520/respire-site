window.ONE_MEMORY_PROMPTS = {
  en: `Help me install and verify memocap (@memocap/cli), so my AI tools can keep using the same memory.

1. Check my OS, Node.js and any existing memocap installation. Follow the official instructions: npm i -g @memocap/cli, then memocap doctor. Explain required model and dependency downloads.
2. Check supported local agent integrations. Preserve and back up existing configuration, then connect the agents and memory scope I choose according to the official documentation.
3. Ask whether I want local offline use or cross-device sync. Let me enter credentials and keys locally; never ask me to paste passwords, Secret Keys or my entire memory library into chat.
4. Use a non-sensitive test memory to verify saving, recall and handoff to another agent. Report what actually worked and what remains. Keep test data separate from real projects.

Use the current official instructions at https://memocap.ai/ and for @memocap/cli. Do not invent parameters, server addresses or download URLs.`,
  zh: `请帮我安装并验证 memocap（npm 包 @memocap/cli），让我的 AI 能继续使用同一份记忆。

1. 检查系统、Node.js 和现有 memocap 安装。按官方说明执行 npm i -g @memocap/cli，再运行 memocap doctor；说明需要下载的模型与依赖。
2. 检查本机支持的 Agent 接入方式。保留已有配置，备份后按官方说明接入我选定的 Agent 与记忆范围。
3. 询问我使用本地离线模式还是跨设备同步，再完成相应配置。账号与密钥由我在本机输入，不要要求我把密码、Secret Key 或完整记忆库贴进对话。
4. 用一条无敏感信息的测试记忆，验证保存、检索，以及另一个 Agent 能否继续使用；报告实际成功项和待完成项。不要把测试记忆混入正式项目。

安装前以 https://memocap.ai/ 和 @memocap/cli 的当前官方说明为准；不要猜测未提供的参数、服务器或下载地址。`,
  es: `Ayúdame a instalar y verificar memocap (@memocap/cli) para que mis herramientas de IA sigan usando la misma memoria.

1. Comprueba el sistema, Node.js y las instalaciones existentes. Sigue las instrucciones oficiales: npm i -g @memocap/cli y después memocap doctor. Explica qué modelos y dependencias se descargarán.
2. Comprueba las integraciones locales compatibles. Conserva y respalda la configuración existente; conecta los agentes y el alcance de memoria que yo elija siguiendo la documentación oficial.
3. Pregunta si prefiero uso local sin conexión o sincronización entre dispositivos. Las credenciales y claves las introduzco localmente; no me pidas contraseñas, Secret Keys ni toda mi memoria en el chat.
4. Usa un recuerdo de prueba sin datos sensibles para verificar guardado, recuperación y continuidad con otro agente. Informa de los resultados reales y lo pendiente. Separa la prueba de mis proyectos.

Consulta las instrucciones actuales de https://memocap.ai/ y @memocap/cli. No inventes parámetros, servidores ni direcciones de descarga.`,
  fr: `Aidez-moi à installer et vérifier memocap (@memocap/cli), pour que mes outils d’IA utilisent la même mémoire.

1. Vérifiez le système, Node.js et les installations existantes. Suivez les instructions officielles : npm i -g @memocap/cli, puis memocap doctor. Expliquez les téléchargements de modèles et de dépendances nécessaires.
2. Vérifiez les intégrations locales compatibles. Préservez et sauvegardez la configuration, puis connectez les agents et le périmètre de mémoire que je choisis selon la documentation officielle.
3. Demandez si je préfère le mode local hors ligne ou la synchronisation entre appareils. Je saisirai mes identifiants et clés localement ; ne me demandez pas de mots de passe, de Secret Keys ni ma mémoire complète dans le chat.
4. Utilisez un souvenir de test non sensible pour vérifier l’enregistrement, la recherche et la reprise par un autre agent. Indiquez les résultats réels et ce qui reste à faire. Séparez les tests des projets réels.

Consultez les instructions actuelles de https://memocap.ai/ et de @memocap/cli. N’inventez ni paramètres, ni serveurs, ni URL de téléchargement.`,
  ko: `AI 도구가 같은 기억을 계속 사용할 수 있도록 memocap(@memocap/cli)를 설치하고 검증해 주세요.

1. 운영체제, Node.js, 기존 memocap 설치를 확인하세요. 공식 안내에 따라 npm i -g @memocap/cli 실행 후 memocap doctor를 실행하고 필요한 모델과 의존성 다운로드를 설명하세요.
2. 지원하는 로컬 Agent 연결 방식을 확인하세요. 기존 설정을 보존하고 백업한 뒤, 제가 선택한 Agent와 기억 범위를 공식 문서에 따라 연결하세요.
3. 로컬 오프라인 사용과 기기 간 동기화 중 무엇을 원하는지 물어보세요. 계정과 키는 제가 로컬에서 입력합니다. 비밀번호, Secret Key, 전체 기억을 대화에 붙여넣으라고 요구하지 마세요.
4. 민감하지 않은 테스트 기억으로 저장, 검색, 다른 Agent로의 연결을 확인하세요. 실제 성공한 항목과 남은 작업을 보고하고 테스트 데이터를 실제 프로젝트와 분리하세요.

https://memocap.ai/ 및 @memocap/cli의 최신 공식 안내를 따르세요. 매개변수, 서버, 다운로드 주소를 추측하지 마세요.`,
  ja: `AIツールで同じ記憶を使い続けられるよう、memocap（@memocap/cli）のインストールと検証を手伝ってください。

1. OS、Node.js、既存のmemocapを確認してください。公式の手順に従って npm i -g @memocap/cli、その後 memocap doctor を実行し、必要なモデルや依存関係のダウンロードを説明してください。
2. 対応するローカルAgentの接続方法を確認してください。既存の設定を保護・バックアップし、私が選んだAgentと記憶の範囲を公式文書に従って接続してください。
3. ローカルのオフライン利用か、デバイス間同期かを確認してください。認証情報と鍵は私がローカルで入力します。パスワード、Secret Key、記憶全体をチャットに貼り付けるよう求めないでください。
4. 機密情報を含まないテスト記憶で、保存、検索、別のAgentへの引き継ぎを検証してください。実際に成功した項目と未完了の項目を報告し、テストと本番プロジェクトを分けてください。

https://memocap.ai/ と @memocap/cli の最新の公式案内に従ってください。引数、サーバー、ダウンロードURLを推測しないでください。`
};
