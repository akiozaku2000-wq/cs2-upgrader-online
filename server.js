'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const port = Number(process.env.PORT || 8765);
const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const players = new Map();
const chat = [];
let match = null;

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','content-length':body.length,'cache-control':'no-store'});
  res.end(body);
}
function reject(res, message, status=400) { json(res, status, {error:message}); }
function playerFor(token) { return players.get(token); }
function cleanup() { const now=Date.now(); for(const [token,p] of players) if(now-p.seen>30000) players.delete(token); finishMatch(); }
function finishMatch() {
  if(!match || match.active===false || Date.now()<match.ends) return;
  match.active=false;
  const scores=Object.entries(match.scores).sort((a,b)=>b[1]-a[1]);
  match.winner=scores.length && scores[0][1]>0 && (!scores[1] || scores[0][1]>scores[1][1]) ? scores[0][0] : 'ничья';
  if(match.winner!=='ничья') {const winner=[...players.values()].find(p=>p.nick===match.winner); if(winner) winner.wins++;}
}
function state() {
  finishMatch();
  const list=[...players.values()];
  return {
    players:list.map(p=>({nick:p.nick})).sort((a,b)=>a.nick.localeCompare(b.nick,'ru')),
    leaders:list.sort((a,b)=>b.wins-a.wins||b.totalTaps-a.totalTaps).map(p=>({nick:p.nick,wins:p.wins,totalTaps:p.totalTaps})),
    chat:chat.slice(-50),
    match:match && {active:match.active,remaining:Math.max(0,match.ends-Date.now()),winner:match.winner,scores:Object.entries(match.scores).sort((a,b)=>b[1]-a[1]).map(([nick,taps])=>({nick,taps}))}
  };
}
async function readBody(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {size+=chunk.length;if(size>4096)throw Error('Слишком большой запрос.');chunks.push(chunk);}
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const server=http.createServer(async(req,res)=>{
  try {
    cleanup();
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET' && url.pathname==='/') {
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-length':html.length,'cache-control':'no-store'});res.end(html);return;
    }
    if(!url.pathname.startsWith('/api/')) {reject(res,'Не найдено.',404);return;}
    const data=req.method==='POST'?await readBody(req):{};
    if(req.method==='POST' && url.pathname==='/api/join') {
      const nick=String(data.nick||'').trim();
      if(nick.length<2||nick.length>24||/[\x00-\x1f]/.test(nick)) {reject(res,'Ник должен содержать 2–24 символа.');return;}
      if([...players.values()].some(p=>p.nick.toLocaleLowerCase('ru')===nick.toLocaleLowerCase('ru'))) {reject(res,'Ник уже занят в комнате.');return;}
      const token=crypto.randomBytes(24).toString('hex');
      players.set(token,{nick,seen:Date.now(),wins:0,totalTaps:0,lastTap:0,lastChat:0});json(res,200,{token});return;
    }
    const token=req.method==='GET'?url.searchParams.get('token'):data.token;
    const player=playerFor(token);
    if(!player) {reject(res,'Подключись заново.',401);return;}
    player.seen=Date.now();
    if(req.method==='GET' && url.pathname==='/api/state') {json(res,200,state());return;}
    if(req.method==='POST' && url.pathname==='/api/leave') {players.delete(token);json(res,200,{ok:true});return;}
    if(req.method==='POST' && url.pathname==='/api/chat') {
      const text=String(data.text||'').trim();
      if(!text||text.length>200) {reject(res,'Сообщение должно содержать 1–200 символов.');return;}
      if(Date.now()-player.lastChat<700) {reject(res,'Подожди перед отправкой.');return;}
      player.lastChat=Date.now();chat.push({nick:player.nick,text,time:new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})});
      if(chat.length>50)chat.shift();json(res,200,{ok:true});return;
    }
    if(req.method==='POST' && url.pathname==='/api/start') {
      if(match?.active) {reject(res,'Матч уже идёт.');return;}
      const scores=Object.fromEntries([...players.values()].map(p=>[p.nick,0]));
      match={active:true,ends:Date.now()+15000,winner:'',scores};json(res,200,{ok:true});return;
    }
    if(req.method==='POST' && url.pathname==='/api/tap') {
      if(!match?.active) {reject(res,'Матч не идёт.');return;}
      if(Date.now()-player.lastTap>=80) {player.lastTap=Date.now();match.scores[player.nick]=(match.scores[player.nick]||0)+1;player.totalTaps++;}
      json(res,200,{ok:true});return;
    }
    reject(res,'Неизвестный запрос.',404);
  } catch(e) {reject(res,e.message||'Ошибка сервера.');}
});
server.listen(port,'0.0.0.0',()=>console.log(`CS2 Upgrader server: http://localhost:${port}`));
