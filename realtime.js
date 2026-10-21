/* Supabase's Phoenix v1 protocol. Heartbeats keep the socket alive; they do not fetch tasks. */
(() => {
  class SlateRealtime {
    constructor({url,key,token,changed,status}) {
      Object.assign(this,{url,key,token,changed,status});
      this.delay=1000; this.stopped=false; this.connect();
    }
    send(event,payload,topic='realtime:slate-revision') {
      const ref=String(++this.serial);
      this.socket.send(JSON.stringify({topic,event,payload,ref,join_ref:'1'}));return ref;
    }
    async connect() {
      if(this.stopped)return;
      try {
        const access=await this.token();if(this.stopped)return;
        this.access=access;this.serial=0;this.pendingHeartbeat=null;this.joined=false;
        const socket=this.socket=new WebSocket(this.url.replace('https:','wss:')+'/realtime/v1/websocket?vsn=1.0.0&apikey='+encodeURIComponent(this.key));
        socket.onopen=()=>{
          this.send('phx_join',{config:{broadcast:{ack:false,self:false},presence:{enabled:false},postgres_changes:[{event:'UPDATE',schema:'public',table:'slate_revision'}]},access_token:this.access});
          this.joinTimeout=setTimeout(()=>socket.close(),20000);
          this.heartbeat=setInterval(()=>void this.beat(socket),25000);
        };
        socket.onmessage=event=>{
          if(socket!==this.socket)return;
          let msg;try{msg=JSON.parse(event.data);}catch{return;}
          if(msg.event==='phx_reply'&&msg.ref===this.pendingHeartbeat)this.pendingHeartbeat=null;
          if(msg.event==='phx_reply'&&msg.ref==='1'){
            if(msg.payload?.status!=='ok'||!msg.payload.response?.postgres_changes?.length){socket.close();return;}
            clearTimeout(this.joinTimeout);this.joined=true;this.delay=1000;this.status(true);this.changed();
          }else if(msg.event==='postgres_changes')this.changed();
          else if(['phx_error','phx_close'].includes(msg.event)||(msg.event==='system'&&msg.payload?.status==='error'))socket.close();
        };
        socket.onerror=()=>socket.close();
        socket.onclose=()=>{if(socket===this.socket)this.retry();};
      }catch{this.retry();}
    }
    async beat(socket) {
      if(this.stopped||socket!==this.socket||socket.readyState!==1)return;
      try{
        if(this.pendingHeartbeat){socket.close();return;}
        const next=await this.token();
        if(this.stopped||socket!==this.socket||socket.readyState!==1)return;
        if(next!==this.access){this.access=next;this.send('access_token',{access_token:next});}
        this.pendingHeartbeat=this.send('heartbeat',{},'phoenix');
      }catch{socket.close();}
    }
    retry() {
      clearInterval(this.heartbeat);clearTimeout(this.joinTimeout);clearTimeout(this.reconnect);
      this.joined=false;if(this.stopped)return;this.status(false);
      this.reconnect=setTimeout(()=>this.connect(),this.delay);this.delay=Math.min(60000,this.delay*2);
    }
    stop() {this.stopped=true;clearInterval(this.heartbeat);clearTimeout(this.joinTimeout);clearTimeout(this.reconnect);this.socket?.close();}
  }
  window.SlateRealtime=SlateRealtime;
})();
