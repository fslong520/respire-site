export const SITE_BASE=import.meta.env.BASE_URL;
export const DASHBOARD_URL=import.meta.env.VITE_DASHBOARD_URL || 'https://dash.rsrs.rs';
export const ADMIN_URL=import.meta.env.VITE_ADMIN_URL || 'https://admin.rsrs.rs';
const DOCS_ORIGIN=(import.meta.env.VITE_DOCS_URL || 'https://docs.rsrs.rs').replace(/\/+$/,'');
export const DOCS_URL=DOCS_ORIGIN;
export const docsUrl=(lang:'en'|'zh',path:string)=>`${DOCS_ORIGIN}${lang==='zh'?'/zh':''}${path.startsWith('/')?path:`/${path}`}`;
export const SCULPTURE_URL=`${SITE_BASE}memory-fiber-sculpture.png`;
export const MEMORY_CLOUD_URL=`${SITE_BASE}memory-cloud.bin`;
