import fs from 'node:fs';
const BASE='http://127.0.0.1:18443';
const DIR='/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin/qa/p5-batch/c0/';
fs.mkdirSync(DIR,{recursive:true});
const out=[];const log=(s)=>{out.push(new Date().toISOString().slice(11,19)+' '+s);console.log(s);fs.writeFileSync(DIR+'live-fire-trace.txt',out.join('\n'));};
const a2a=async(method,params,ms=30000)=>{return await (await fetch(BASE+'/a2a',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:method+Date.now(),method,params}),signal:AbortSignal.timeout(ms)})).json().catch((e)=>({fetchErr:String(e).slice(0,120)}))};
const mcp=async(b)=>(await fetch(BASE+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b),signal:AbortSignal.timeout(120000)})).json().catch(e=>({err:String(e)}));
async function sendGoal(text){const r=await a2a('message/send',{message:{role:'user',parts:[{kind:'text',text}]}},60000);return r?.result?.id??null;}
async function poll(tid,states,maxPolls,every){for(let i=0;i<maxPolls;i++){await new Promise(x=>setTimeout(x,every));const g=await a2a('tasks/get',{id:tid});const st=g?.result?.status?.state??'';if(states.includes(st))return {st,g};}return {st:'TIMEOUT',g:null};}
(async()=>{
 log('=== 零副作用真机复验：不存在的包 ⇒ data.success=false ⇒ 折叠诚实呈报 ===');
 // 步骤0：折叠前基线形态无需采（批13 已证假成功呈报）；直接走委派
 const GOAL='请立即调用工具 app.winget.uninstall，参数 id="Nonexistent.Test.Zzz"（真卸载，不要 dryRun）。这是唯一动作，完成后停止。';
 const tid=await sendGoal(GOAL);log('taskId='+tid);if(!tid)return;
 let {st,g}=await poll(tid,['input-required','completed','failed'],24,15000);log('首轮态='+st);
 if(st==='input-required'){
   const m=JSON.stringify(g?.result??{}).match(/apr_[a-f0-9]+/i);const ap=m?m[0]:null;log('挂起 approvalId='+ap);
   fs.writeFileSync(DIR+'hang.json',JSON.stringify(g?.result?.status?.message??{},null,1));
   if(!ap){log('无 approvalId 退出');return;}
   const ar=await a2a('message/send',{message:{role:'user',taskId:tid,parts:[{kind:'data',data:{approvalId:ap,approved:true}}]}},60000);
   log('已批准 resp-state='+(ar?.result?.status?.state??''));
   const r2=await poll(tid,['completed','failed','canceled'],40,15000);log('续跑终态='+r2.st);
   fs.writeFileSync(DIR+'final.json',JSON.stringify(r2.g?.result??{},null,1));
   const parts=r2.g?.result?.status?.message?.parts||[];
   for(const p of parts){if(p.kind==='text')log('呈报文本: '+(p.text||'').slice(0,300));}
 } else if(st==='completed'){
   fs.writeFileSync(DIR+'final.json',JSON.stringify(g?.result??{},null,1));
   log('未挂起直接完成（检查 LLM 是否真调工具或拒绝）');
 } else { log('异常终态 '+st); fs.writeFileSync(DIR+'final.json',JSON.stringify(g?.result??{},null,1)); }
 // 链上取证提示：S? traceId 待从 final.json 提取，主理人另行链读
 log('DONE');
})().catch(e=>log('ERR '+e.message));
