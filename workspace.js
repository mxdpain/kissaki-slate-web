/* Notes retain their original records and permissions in the Kissaki website. */
(() => {
 class SlateWorkspace {
  constructor({url,account,token,changed,error}){
   if(!['https://kissaki-studios.netlify.app','https://kissaki-handoff-test.netlify.app'].includes(url))throw Error('Invalid workspace origin');
   Object.assign(this,{url,token,changed,error});this.key='slate.workspace:'+url+':'+String(account);this.etags={};this.authorized=false;
   try{this.state=JSON.parse(localStorage.getItem(this.key))||{notes:[],rows:[],outbox:[],conflicts:[]}}catch{throw Error('Cannot read saved workspace edits')}
   void this.sync();
  }
  save(){localStorage.setItem(this.key,JSON.stringify(this.state))}
  async request(path,body){const headers={Authorization:'Bearer '+await this.token(),'Content-Type':'application/json'};if(!body&&this.etags[path])headers['If-None-Match']=this.etags[path];const r=await fetch(this.url+'/slate-api/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});if(r.status===304)return null;if(!r.ok)throw Object.assign(Error('Workspace changed or is unavailable. Draft retained.'),{conflict:[400,403,404,409].includes(r.status)});if(r.headers.get('ETag'))this.etags[path]=r.headers.get('ETag');return r.json()}
  snapshot(){return this.authorized?this.state.notes.map(n=>({id:'workspace:'+n.handoff_id,title:'Notes · '+n.title,tasks:this.state.rows.filter(r=>r.handoff_id===n.handoff_id).map(r=>({i:'workspace:'+r.id,text:r.body,done:!!r.complete,due:r.due_date,assignee:r.assignee_names||r.assignee_name,readonly:!r.can_edit}))})):[]}
  apply(entry){const {path,body}=entry,fields=body.fields;if(path==='tasks'){if(!this.state.rows.some(r=>r.id===body.id))this.state.rows.push({id:body.id,handoff_id:body.handoffId,...fields,complete:false,revision:0,can_edit:true})}else{const r=this.state.rows.find(r=>r.id===path.split('/')[1]);if(r){if(fields.deleted)this.state.rows=this.state.rows.filter(x=>x!==r);else Object.assign(r,fields,{revision:r.revision+1})}}}
  command(msg){
   const hid=msg.list.split(':')[1],id=msg.i?.split(':')[1],row=this.state.rows.find(r=>r.id===id&&r.handoff_id===hid);let entry;
   if(msg.cmd==='add'&&msg.text.trim())entry={path:'tasks',body:{id:crypto.randomUUID(),handoffId:hid,fields:{body:msg.text.trim(),due_date:msg.due||null}}};
   if(row&&['toggle','edit','due','remove'].includes(msg.cmd))entry={path:'tasks/'+id,body:{revision:row.revision,fields:msg.cmd==='toggle'?{complete:msg.done}:msg.cmd==='edit'?{body:msg.text.trim()}:msg.cmd==='due'?{due_date:msg.due||null}:{deleted:true}}};
   if(!entry)return;entry.body.requestId=crypto.randomUUID();const previous=structuredClone(this.state);try{this.state.outbox.push(entry);this.apply(entry);this.save()}catch(e){this.state=previous;throw e}this.changed();void this.sync();
  }
  async sync(){if(this.stopped)return;if(this.busy){this.again=true;return}clearTimeout(this.timer);this.busy=true;try{
   while(this.state.outbox.length){const first=this.state.outbox[0];try{await this.request(first.path,first.body)}catch(e){if(!e.conflict)throw e;this.state.conflicts.push(first)}this.state.outbox=this.state.outbox.filter(e=>e.body.requestId!==first.body.requestId);this.etags={};this.save()}
   const notes=await this.request('notes'),rows=await this.request('tasks');if(this.stopped)return;if(notes)this.state.notes=notes;if(rows){this.state.rows=rows;this.state.outbox.forEach(e=>this.apply(e))}this.authorized=true;this.save();this.changed();if(this.state.conflicts.length)this.error('Workspace conflict saved; open the original note to review.');
  }catch(e){this.authorized=false;this.changed();this.error(e.message)}finally{this.busy=false;if(!this.stopped)this.timer=setTimeout(()=>this.sync(),this.again?0:30000);this.again=false}}
  stop(){this.stopped=true;clearTimeout(this.timer)}
 }
 window.SlateWorkspace=SlateWorkspace;
})();
