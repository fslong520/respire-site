import {ArrowUpRight} from 'lucide-react';
import {docsUrl} from '../destinations';
type Lang='en'|'zh';
const plugins=[
  {id:'zcode',name:'ZCode',path:'/plugins/zcode',en:'Marketplace plugin with recall, prefix storage and a Stop storage check.',zh:'市场插件：召回、「记：」落库与 Stop 存储检查。'},
  {id:'kimi',name:'Kimi Code',path:'/plugins/kimi',en:'Kimi Code hooks with per-turn recall and prefix storage.',zh:'Kimi Code 钩子：每轮召回与前缀落库。'},
  {id:'dim',name:'Dim',path:'/plugins/dimcode',en:'Dim marketplace plugin with session rules and storage checks.',zh:'Dim 市场插件：会话简则与存储检查。'},
  {id:'qoder',name:'Qoder',path:'/plugins/qoder',en:'Qoder hooks with recall, storage and a closing check.',zh:'Qoder 钩子：召回、落库与收尾检查。'},
  {id:'workbuddy',name:'WorkBuddy',path:'/plugins/workbuddy',en:'WorkBuddy plugin with session rules and bounded reminders.',zh:'WorkBuddy 插件：会话简则与有界存储提醒。'},
  {id:'hermes',name:'Hermes',path:'/plugins/hermes',en:'Directory memory provider for Hermes Agent.',zh:'Hermes Agent 的目录式记忆 provider。'},
  {id:'codex',name:'Codex',path:'/plugins/codex',en:'Native Codex plugin with recall, explicit store and Stop reminders.',zh:'Codex 原生插件：召回、显式落库与 Stop 提醒。'},
  {id:'pi',name:'Pi',path:'/plugins/pi',en:'Native Pi extension with recall and end-of-turn review.',zh:'Pi 原生扩展：召回与轮末存料审查。'},
];
export default function Plugins({lang}:{lang:Lang}){
  const t=(a:string,b:string)=>lang==='en'?a:b;
  return <section className="plugins-section" id="plugins">
    <div className="section-kicker"><span>{t('CONNECT / PLUGIN ECOSYSTEM','连接 / 插件生态')}</span><span>{t('EIGHT HOSTS. ONE MEMORY.','八个宿主，一份记忆。')}</span></div>
    <div className="plugins-heading">
      <h2>{t('Plugins for the agents','为你正在使用的智能体')}<br/><em>{t('you already use.','装上记忆。')}</em></h2>
      <p>{t('Native adapters bring the same local memory layer into the hosts you already work in. Open the setup guide for your client.','原生适配把同一套本地记忆层带进你正在使用的宿主。打开对应客户端的使用指南。')}</p>
    </div>
    <div className="plugin-grid">
      {plugins.map((plugin,i)=><a className="plugin-card" href={docsUrl(lang,plugin.path)} target="_blank" rel="noopener noreferrer" data-plugin-card data-plugin={plugin.id} key={plugin.id}>
        <span className="plugin-index">{String(i+1).padStart(2,'0')}</span>
        <h3>{plugin.name}</h3>
        <p>{lang==='en'?plugin.en:plugin.zh}</p>
        <span className="plugin-link">{t('Read the guide','查看使用指南')}<ArrowUpRight size={14}/></span>
      </a>)}
    </div>
    <a className="plugins-all" href={docsUrl(lang,'/plugins/')} target="_blank" rel="noopener noreferrer">{t('Browse all plugin guides','浏览全部插件文档')}<ArrowUpRight size={14}/></a>
  </section>;
}
