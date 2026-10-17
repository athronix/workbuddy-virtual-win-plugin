import fs from 'node:fs';
const BASE='http://127.0.0.1:18443';
const DIR='/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin/qa/p5-batch/b16/';
fs.mkdirSync(DIR,{recursive:true});
const out=[];
const log=(s)=>{out.push(new Date().toISOString().slice(11,19)+' '+s);console.log(s);fs.writeFileSync(DIR+'v20-trace4.txt',out.join('\n'));};
const a2a=async(method,params,ms=60000)=>{return await (await fetch(BASE+'/a2a',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:method+Date.now(),method,params}),signal:AbortSignal.timeout(ms)})).json().catch((e)=>({fetchErr:String(e).slice(0,200)}))};
(async()=>{
 const h0=await (await fetch(BASE+'/health',{signal:AbortSignal.timeout(20000)})).json().catch(()=>({}));
 log('起始 llm='+JSON.stringify(h0.llmSession));
 log('=== V20 重打：趁常驻会话 ready ===');
 const U='你必须调用工具 app.winget.uninstall，参数 id="Nonexistent.Test.Zzz"，不要 dryRun。不要只回复文字，必须先发起这一次工具调用。完成该调用后停止。';
 const r=await a2a('message/send',{message:{role:'user',parts:[{kind:'text',text:U}]}},60000);
 const tid=r?.result?.id;log('taskId='+tid);
 if(!tid){log('send fail '+JSON.stringify(r).slice(0,300));return;}
 let st='',g=null;
 for(let i=0;i<24;i++){
   await new Promise(x=>setTimeout(x,15000));
   g=await a2a('tasks/get',{id:tid});
   st=g?.result?.status?.state??'';
   if(['input-required','completed','failed','canceled'].includes(st))break;
 }
 log('首轮态='+st);
 fs.writeFileSync(DIR+'v20-suspend4.json',JSON.stringify(g?.result??{},null,1));
 if(st!=='input-required'){log('未挂起=非目标样本（登记退出）');return;}
 const ap=(JSON.stringify(g?.result??{}).match(/apr_[a-f0-9]+/i)||[])[0];log('approvalId='+ap);
 if(!ap){log('无 apr 令牌');return;}
 const ar=await a2a('message/send',{message:{role:'user',taskId:tid,parts:[{kind:'data',data:{approvalId:ap,approved:true}}]}},60000);
 log('批准 resp='+(ar?.result?.status?.state??''));
 let st2='',g2=null;
 for(let i=0;i<36;i++){
   await new Promise(x=>setTimeout(x,10000));
   g2=await a2a('tasks/get',{id:tid});
   st2=g2?.result?.status?.state??'';
   if(['completed','failed','canceled'].includes(st2))break;
 }
 log('续跑终态='+st2);
 fs.writeFileSync(DIR+'v20-final4.json',JSON.stringify(g2?.result??{},null,1));
 const parts=g2?.result?.status?.message?.parts||[];
 for(const p of parts){
   if(p.kind==='text')log('呈报: '+(p.text||'').slice(0,400));
   if(p.kind==='data'){
     log('data keys='+Object.keys(p.data||{}).join(',')+' ok='+p.data?.ok+' stepCount='+p.data?.stepCount);
     for(const s of (p.data?.steps||[]))log('step: cap='+s.capabilityId+' ok='+s.ok+' errCode='+(s.errorCode??'')+' summary='+(s.summary||'').slice(0,260));
   }
 }
 const h=await (await fetch(BASE+'/health',{signal:AbortSignal.timeout(20000)})).json().catch(()=>({}));
 log('收尾 policyGate='+JSON.stringify(h.policyGate)+' llm='+JSON.stringify(h.llmSession));
 log('DONE');
})().catch(e=>log('ERR '+String(e).slice(0,300)));
