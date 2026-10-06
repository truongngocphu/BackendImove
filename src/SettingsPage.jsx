import React from 'react';
import { Activity, Database, MapPinned, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { getCoreConnection } from './coreApi.js';
import { coreUrl } from './apiRuntime.js';
import { PageError, PageLoading } from './AdminPageState.jsx';
import { trackAsiaConfig, usesTrackAsiaPublicTestKey } from './trackAsiaConfig.js';

export default function SettingsPage(){
  const [state,setState]=React.useState(null);
  const [loading,setLoading]=React.useState(true);
  const [error,setError]=React.useState('');

  const load=React.useCallback(async()=>{
    setLoading(true);
    setError('');
    try{
      const core=await getCoreConnection(true);
      let adminApi={};
      try{
        const response=await fetch(coreUrl('/api/health'),{cache:'no-store'});
        adminApi=await response.json().catch(()=>({}));
        adminApi.httpStatus=response.status;
        adminApi.ok=response.ok;
      }catch(e){
        adminApi={ok:false,message:e?.message||String(e)};
      }
      setState({core,adminApi});
    }catch(e){
      setError(e.message||String(e));
    }finally{
      setLoading(false);
    }
  },[]);

  React.useEffect(()=>{load()},[load]);
  if(loading&&!state)return <PageLoading text="Đang kiểm tra hệ thống..."/>;
  if(error&&!state)return <PageError message={error} onRetry={load}/>;

  return <section className="enterprise-page">
    <header className="enterprise-page-head">
      <div><span className="enterprise-eyebrow">SYSTEM CONFIGURATION</span><h1>Cài đặt hệ thống</h1><p>Admin kết nối trực tiếp Core Backend public, không phụ thuộc proxy VPS.</p></div>
      <button className="button" onClick={load}><RefreshCw size={15}/>Kiểm tra lại</button>
    </header>
    <div className="settings-health-grid">
      <article><Server/><span>Core Backend</span><b>{state?.core?.connected?'Đã kết nối':'Mất kết nối'}</b><small>{state?.core?.baseUrl||'—'}</small></article>
      <article><Activity/><span>Admin API</span><b>{state?.adminApi?.ok===false?'Cảnh báo':'Hoạt động'}</b><small>HTTP {state?.adminApi?.httpStatus||'—'}</small></article>
      <article><Database/><span>MongoDB Atlas</span><b>{state?.adminApi?.state===1||state?.adminApi?.database?'Connected':'Qua Core Backend'}</b><small>{state?.adminApi?.database||'th79_imove'}</small></article>
      <article><MapPinned/><span>TrackAsia</span><b>{usesTrackAsiaPublicTestKey()?'Test key':'Configured'}</b><small>{trackAsiaConfig.detailLevel||'enhanced'} · {trackAsiaConfig.styleUrl?'Custom style':'Streets v2'}</small></article>
    </div>
    <section className="card enterprise-panel"><header><div><h2>Production contract</h2><p>Không yêu cầu sửa Nginx/PM2 route để Admin tìm Core Backend.</p></div><ShieldCheck size={18}/></header><div className="settings-contract"><code>Core: https://backendimove.daututh79.com</code><code>Admin Web: static build</code><code>Bearer Admin Token</code><code>VITE_TRACKASIA_API_KEY</code></div></section>
  </section>;
}
