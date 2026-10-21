/* Slate web bridge. The same slate UI sends commands through this adapter.
   Only a publishable key is allowed. RLS enforces approved membership. */
(() => {
  'use strict';
  const names = ['Uj', 'Juan', 'Eddy', 'Plas', 'Verso', 'Dev'];
  let deployedConfig = false;
  let config, state, session, editing = false, busy = false;
  let serverRevision=null, live=null, liveConnected=false, syncRequested=false, retryTimer=null, retryDelay=2000, notifyButton=null;
  let receiveReady = false, refreshBusy = null, ownsTab = false;
  const configKey = 'slate.config';
  const sessionKey = 'slate.session';
  const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
  const save = () => localStorage.setItem(stateKey(), JSON.stringify(state));
  const stateKey = () => 'slate.cache:' + config.supabase_url + ':' + config.me;
  const cache = () => ({rows:{}, lists:names.slice(), outbox:[], current:config.me});
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
  const receive = value => { if (window.slateReceive) window.slateReceive(value); };
  const syncStatus = (error = null) => receive({event:'sync', error:error || (liveConnected ? null : 'Reconnecting live updates'), pending:state?.outbox.length || 0});
  const rowOrder = (a,b) => a.position-b.position || (a.created_at || '').localeCompare(b.created_at || '') || a.id.localeCompare(b.id);
  const snapshot = () => state.lists.slice().sort((a,b) => (names.includes(a)?names.indexOf(a):99)-(names.includes(b)?names.indexOf(b):99) || a.localeCompare(b)).map(name => ({
    id:name, title:name, tasks:Object.values(state.rows).filter(r=>r.list===name).sort(rowOrder).map(r=>({...r,i:r.id}))
  }));
  function render(force = false) {
    if (receiveReady && (force || !editing) && state) receive({event:'lists', lists:snapshot(), current:state.current, today:today()});
  }
  function validConfig(value) {
    const url = new URL(value.supabase_url);
    if (url.protocol !== 'https:' || url.pathname !== '/' || !names.includes(value.me)) throw Error('Choose your team name and a valid HTTPS project URL.');
    const key = value.supabase_anon_key;
    if (!key || key.startsWith('sb_secret_')) throw Error('Use the publishable key.');
    if (key.includes('.')) {
      try {
        const body = JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
        if (body.role === 'service_role') throw Error('Never use a service-role key in Slate.');
      } catch (e) { if (e.message.includes('service-role')) throw e; }
    }
    return {...value, supabase_url:url.origin};
  }
  async function raw(path, method='GET', data, token, extra={}) {
    const headers = {apikey:config.supabase_anon_key, 'Content-Type':'application/json', ...extra};
    if (token) headers.Authorization = 'Bearer '+token;
    const response = await fetch(config.supabase_url+path, {method, headers,
      body:data===undefined?undefined:JSON.stringify(data), signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw Error(response.status === 401 ? 'Sign in to sync' : 'Sync request failed ('+response.status+'). Your edits remain queued.');
    const text = await response.text(); return text ? JSON.parse(text) : null;
  }
  async function token() {
    if (!session?.access_token) throw Error('Sign in to sync');
    if ((session.expires_at||0)*1000 < Date.now()+60000) {
      if (!refreshBusy) refreshBusy = raw('/auth/v1/token?grant_type=refresh_token','POST',{refresh_token:session.refresh_token})
        .then(value => { session = value; session.expires_at ||= Math.floor(Date.now()/1000)+value.expires_in; localStorage.setItem(sessionKey+':'+config.supabase_url,JSON.stringify(session)); })
        .finally(()=>{refreshBusy=null;});
      await refreshBusy;
    }
    return session.access_token;
  }
  async function api(path, method='GET', data, headers) { return raw('/rest/v1/'+path,method,data,await token(),headers); }
  function apply(rows, op) {
    const data = op.data;
    if (op.op==='add') rows[data.id] ||= {...data};
    if (op.op==='update' && rows[data.id]) Object.assign(rows[data.id],data.fields);
    if (op.op==='remove') delete rows[data.id];
    if (op.op==='reorder') data.task_ids.forEach((id,index)=>{if(rows[id]?.list===data.list_name)rows[id].position=index*1000;});
  }
  function queue(op,data) {
    const previous = structuredClone(state);
    try {
      const entry={key:crypto.randomUUID(),op,data};
      state.outbox.push(entry); apply(state.rows,entry);
      if(op==='list'&&!state.lists.includes(data.name))state.lists.push(data.name);
      save();
    } catch (e) { state=previous; throw Error('Cannot save this edit on your device. Free some storage and retry.'); }
  }
  async function sendEntry(entry) {
    await api('rpc/slate_apply','POST',{op_key:entry.key,operation:entry.op,payload:entry.data});
  }
  async function sync() {
    if(!config||!state||!session||!ownsTab)return;
    if(busy){syncRequested=true;return;}
    clearTimeout(retryTimer);syncRequested=false;
    busy=true;
    try {
      while(state.outbox.length) {
        const first=state.outbox[0]; await sendEntry(first);
        state.outbox=state.outbox.filter(e=>e.key!==first.key); save();
      }
      const remote=await api('rpc/slate_snapshot_v2','POST',{known_revision:serverRevision});
      if(remote.member!==config.me)throw Error('This email is not approved for '+config.me+'.');
      if(!remote.unchanged){
        const rows=Object.fromEntries(remote.tasks.map(row=>[row.id,row]));
        state.outbox.forEach(op=>apply(rows,op));
        state.rows=rows;
        state.lists=[...new Set([...names,...remote.lists.map(l=>l.name),...Object.values(rows).map(r=>r.list),...state.lists])];
        save();serverRevision=remote.revision;render();
      }
      notifyAssignments();syncStatus();retryDelay=2000;
    } catch(e) {
      syncStatus(e.message);
      retryTimer=setTimeout(()=>void sync(),retryDelay);retryDelay=Math.min(60000,retryDelay*2);
    }
    finally{busy=false;if(syncRequested)queueMicrotask(()=>void sync());}
  }
  function prepareNotifications() {
    if(!state.notified && Object.keys(state.rows).length){
      state.notified=Object.values(state.rows).filter(r=>r.list===config.me).map(r=>r.id);save();
    }
  }
  function notifyAssignments() {
    const mine=Object.values(state.rows).filter(r=>r.list===config.me);
    if(!state.notified){state.notified=mine.map(r=>r.id);save();return;}
    const seen=new Set(state.notified);
    const pending=mine.filter(r=>!r.done&&!seen.has(r.id));
    mine.filter(r=>r.done).forEach(r=>seen.add(r.id));
    if(pending.length&&'Notification'in window&&Notification.permission==='granted'){
      try {
        const n=new Notification(pending.length===1?'New task for '+config.me:pending.length+' new tasks for '+config.me,
          {body:pending.slice(0,4).map(r=>r.text).join('\n')+(pending.length>4?'\n+'+(pending.length-4)+' more tasks':''),tag:'slate-'+pending[0].id});
        n.onclick=()=>{window.focus();state.current=config.me;save();render(true);n.close();};
        pending.forEach(r=>seen.add(r.id));
      }catch{ /* Keep assignments pending so a later attempt can deliver them. */ }
    }
    state.notified=[...seen];save();
  }
  function notificationLabel() {
    if(!notifyButton)return;
    notifyButton.textContent=Notification.permission==='granted'?'alerts on':Notification.permission==='denied'?'alerts blocked':'enable alerts';
    notifyButton.title=Notification.permission==='denied'?'Allow notifications for Slate in your browser site settings.':'Show desktop alerts for new tasks on your list.';
  }
  function startLive() {
    live?.stop();serverRevision=null;liveConnected=false;
    if(!config||!session||!ownsTab)return;
    live=new window.SlateRealtime({url:config.supabase_url,key:config.supabase_anon_key,token,
      changed:()=>void sync(),status:connected=>{liveConnected=connected;syncStatus();}});
    // Catch up after opening; joining the subscription performs another conditional catch-up.
    void sync();
  }
  function command(msg) {
    if(msg.cmd==='init'){receiveReady=true;render();return;}
    if(!state)return;
    if(!ownsTab && !['select','collapse','dismiss','editing','open_file'].includes(msg.cmd)){alert('Slate is open in another tab. Close that tab, then refresh this one.');return;}
    try {
      const lid=msg.list;
      const row=state.rows[msg.i];
      const belongs=row&&row.list===lid;
      if(msg.cmd==='editing'){editing=msg.on;if(!editing)render();return;}
      if(msg.cmd==='select'){state.current=lid;save();return;}
      if(msg.cmd==='collapse'){receive({event:'collapsed',on:msg.on});return;}
      if(msg.cmd==='dismiss'){receive({event:'blur'});return;}
      if(msg.cmd==='open_file'){download(lid);return;}
      if(msg.cmd==='add'&&msg.text.trim()&&state.lists.includes(lid)){
        const now=new Date().toISOString();
        queue('add',{id:crypto.randomUUID(),list:lid,text:msg.text.trim(),due:msg.due||null,done:false,
          position:Math.max(-1000,...Object.values(state.rows).filter(r=>r.list===lid).map(r=>r.position))+1000,
          created_by:config.me,created_at:now,updated_at:now});
      }
      if(['toggle','edit','due'].includes(msg.cmd)&&belongs){
        const fields=msg.cmd==='toggle'?{done:msg.done}:msg.cmd==='due'?{due:msg.due||null}:{text:msg.text.trim()};
        queue('update',{id:msg.i,list:lid,fields});
      }
      if(msg.cmd==='remove'&&belongs)queue('remove',{id:msg.i,list:lid});
      if(msg.cmd==='clear_done')Object.values(state.rows).filter(r=>r.list===lid&&r.done).forEach(r=>queue('remove',{id:r.id,list:lid}));
      if(msg.cmd==='reorder'){
        const actual=Object.values(state.rows).filter(r=>r.list===lid).map(r=>r.id);
        if(new Set(msg.order).size===actual.length&&msg.order.length===actual.length&&actual.every(id=>msg.order.includes(id)))queue('reorder',{list_name:lid,task_ids:msg.order});
      }
      if(msg.cmd==='new_list'){
        const name=msg.title.replace(/[\\/:]+/g,'-').trim();
        if(name&&!/^[._]/.test(name)){queue('list',{name});state.current=name;save();}
      }
      render(true);syncStatus();void sync();
    } catch(e){syncStatus(e.message);alert(e.message);}
  }
  function download(lid){
    const list=snapshot().find(l=>l.id===lid);if(!list)return;
    const raw='# '+list.title+'\n\n'+list.tasks.map(t=>'- ['+(t.done?'x':' ')+'] '+t.text+(t.due?' 📅 '+t.due:'')).join('\n')+'\n';
    const url=URL.createObjectURL(new Blob([raw],{type:'text/markdown'}));
    const a=document.createElement('a');a.href=url;a.download=lid+'.md';a.click();URL.revokeObjectURL(url);
  }
  window.webkit={messageHandlers:{slate:{postMessage:text=>command(JSON.parse(text))}}};

  function panel(){
    const overlay=document.createElement('div');overlay.id='signin';
    overlay.innerHTML=`<form><h2>Slate</h2><p>Sign in with your approved team email.</p>
    <label>Your name<select name="me">${names.map(n=>'<option>'+n+'</option>').join('')}</select></label>
    <div id="connection"><label>Project URL<input name="url" type="url" autocomplete="url" required></label>
    <label>Publishable key<input name="key" autocomplete="off" required></label></div>
    <label>Email<input name="email" type="email" autocomplete="email" required></label>
    <label id="code-label" hidden>Email code<input name="code" inputmode="numeric" autocomplete="one-time-code"></label>
    <p id="auth-message" role="status"></p><button type="submit">Send code</button></form>`;
    document.body.append(overlay);
    const form=overlay.querySelector('form'),message=overlay.querySelector('#auth-message'),button=form.querySelector('button');
    let codeSent=false;
    if(deployedConfig) overlay.querySelector('#connection').hidden=true;
    if(config){form.elements.url.value=config.supabase_url;form.elements.key.value=config.supabase_anon_key;form.elements.me.value=config.me;form.elements.email.value=config.email||'';}
    form.onsubmit=async e=>{
      e.preventDefault();button.disabled=true;message.textContent='';
      try {
        const next=validConfig({supabase_url:form.elements.url.value,supabase_anon_key:form.elements.key.value,me:form.elements.me.value,email:form.elements.email.value.trim()});
        if(state?.outbox.length && config && (next.me!==config.me||next.supabase_url!==config.supabase_url))throw Error('Sync queued edits before switching accounts.');
        config=next;localStorage.setItem(configKey,JSON.stringify(config));
        if(!codeSent){
          await raw('/auth/v1/otp','POST',{email:config.email,create_user:true});codeSent=true;
          overlay.querySelector('#code-label').hidden=false;button.textContent='Sign in';
          form.elements.me.disabled=true;form.elements.email.readOnly=true;form.elements.url.readOnly=true;form.elements.key.readOnly=true;
          message.textContent='Check your email for the sign-in code.';form.elements.code.focus();
        }else{
          const result=await raw('/auth/v1/verify','POST',{email:config.email,token:form.elements.code.value.trim(),type:'email'});
          const members=await raw('/rest/v1/slate_members?select=name','GET',undefined,result.access_token);
          if(members.length!==1||members[0].name!==config.me)throw Error('This email is not approved for '+config.me+'.');
          session=result;session.expires_at||=Math.floor(Date.now()/1000)+result.expires_in;
          localStorage.setItem(sessionKey+':'+config.supabase_url,JSON.stringify(session));
          state=load(stateKey(),cache());prepareNotifications();overlay.remove();render();startLive();
        }
      }catch(e){message.textContent=e.message;}finally{button.disabled=false;}
    };
  }
  document.addEventListener('DOMContentLoaded',async()=>{
    if(navigator.locks) {
      await new Promise(resolve=>navigator.locks.request('slate-active-client', {ifAvailable:true}, async lock=>{
        ownsTab=!!lock;resolve();if(lock)await new Promise(()=>{});
      }));
      if(!ownsTab) {
        document.body.innerHTML='<div id="signin"><p>Slate is open in another tab. Close that tab, then refresh this one.</p></div>';
        return;
      }
    } else { ownsTab=true; }
    const footer=document.querySelector('footer');
    document.querySelector('#openfile').textContent='export .md';
    const sign=document.createElement('button');sign.textContent='sign in';sign.onclick=()=>{if(!document.querySelector('#signin'))panel();};footer.append(sign);
    if('Notification'in window){notifyButton=document.createElement('button');notificationLabel();notifyButton.onclick=async()=>{if(Notification.permission==='denied'){alert('Allow notifications for Slate in your browser site settings.');return;}await Notification.requestPermission();notificationLabel();if(state)notifyAssignments();};footer.append(notifyButton);}
    try {
      config=load(configKey,null);
      if(!config){try{const r=await fetch('./config.json');if(r.ok){config={...await r.json(),me:names[0]};deployedConfig=true;}}catch{}}
      if(config){config=validConfig(config);state=load(stateKey(),cache());session=load(sessionKey+':'+config.supabase_url,null);prepareNotifications();render();}
    }catch{config=null;}
    if(!session)panel();else startLive();
    window.addEventListener('online',()=>startLive());
    window.addEventListener('beforeunload',e=>{if(state?.outbox.length){e.preventDefault();e.returnValue='';}});
  });
})();
