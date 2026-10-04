import {spawnSync} from 'node:child_process';

const result=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build'],{
  stdio:'inherit',
  env:{...process.env,VITE_SITE_BASE:'/preview/',VITE_SITE_OUT_DIR:'../site/dist/preview',VITE_DASHBOARD_URL:'/dashboard',VITE_ADMIN_URL:'/admin'},
});
process.exit(result.status ?? 1);
