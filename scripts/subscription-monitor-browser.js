function subscriptionMailHeaderBlock(raw,provider) {
  if(!['naver','outlook'].includes(provider))return null;
  const message=provider==='outlook'?raw.replace(/^메시지 원본\r?\n/,''):raw;
  if(!/^[A-Za-z][A-Za-z0-9-]*:/.test(message))return null;
  return message.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g,' ');
}
function subscriptionMailAuthenticatedHeader(raw,provider) {
  const headers=subscriptionMailHeaderBlock(raw,provider);
  if(!headers)return false;
  const records=headers.split(/\r?\n/).filter(x=>/^Authentication-Results:/i.test(x));
  if(records.length!==1) return false;
  let value='',quoted=false,depth=0,escaped=false;
  for(const ch of records[0]) {
    if(escaped){escaped=false;continue;}
    if((quoted||depth>0)&&ch==='\\'){escaped=true;continue;}
    if(quoted){if(ch==='"')quoted=false;continue;}
    if(depth>0){if(ch==='(')depth++;else if(ch===')')depth--;continue;}
    if(ch==='"'){quoted=true;value+=' ';continue;}
    if(ch==='('){depth=1;value+=' ';continue;}
    if(ch===')')return false;
    value+=ch;
  }
  if(quoted||depth||escaped)return false;
  const parts=value.split(';').map(x=>x.trim());
  if(provider==='naver' && !/^Authentication-Results:\s*mx\.naver\.com$/i.test(parts[0]))return false;
  if(provider==='outlook' && !/^Authentication-Results:\s*mx\.microsoft\.com(?:\s+\d+)?$/i.test(parts[0]))return false;
  const dmarc=parts.slice(1).filter(x=>/^dmarc\s*=/i.test(x));
  if(dmarc.length!==1 || !/^dmarc=pass(?:\s|$)/i.test(dmarc[0]))return false;
  const from=[...dmarc[0].matchAll(/(?:^|\s)header[.]from=([^\s]+)/gi)];
  if(from.length!==1 || from[0][1].toLowerCase()!=='mail.anthropic.com')return false;
  if(provider==='outlook') {
    const compauth=parts.slice(1).filter(x=>/^compauth\s*=/i.test(x));
    if(compauth.length!==1 || !/^compauth=pass(?:\s|$)/i.test(compauth[0]))return false;
  }
  return true;
}
function subscriptionMailboxIdentity(values,allowedEmails) {
  const emailPattern=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const found=[...new Set(values.flatMap(x=>x.match(emailPattern)||[]).map(x=>x.toLowerCase()))];
  return found.length===1 && allowedEmails.includes(found[0])?found[0]:null;
}
function subscriptionMailTimestamp(raw,provider) {
  const dates=subscriptionMailHeaderBlock(raw,provider)?.split(/\r?\n/).filter(x=>/^Date:/i.test(x))||[];
  if(dates.length!==1)return null;
  const m=dates[0].slice(5).trim().match(/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?([0-9]{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([0-9]{4})\s+([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?\s+([+-][0-9]{4}|GMT|UTC|UT)(?:\s+\([^()\r\n]*\))?$/i);
  if(!m)return null;
  const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].toLowerCase());
  const [day,year,hour,minute,second]=[m[1],m[3],m[4],m[5],m[6]||'0'].map(Number);
  const zone=/^[+-]/.test(m[7])?m[7]:null;
  const zoneHour=zone?Number(zone.slice(1,3)):0,zoneMinute=zone?Number(zone.slice(3)):0;
  if(year<2020||hour>23||minute>59||second>59||zoneHour>23||zoneMinute>59)return null;
  const local=new Date(Date.UTC(year,month,day,hour,minute,second));
  if(local.getUTCFullYear()!==year||local.getUTCMonth()!==month||local.getUTCDate()!==day)return null;
  const offset=(zoneHour*60+zoneMinute)*(zone?.[0]==='-'?-1:1);
  return new Date(local.getTime()-offset*60000).toISOString();
}
function subscriptionMailTimeMatches(raw,provider,expectedAt,visibleAt) {
  const actual=subscriptionMailTimestamp(raw,provider);
  if(!actual)return false;
  const minute=value=>Math.floor(new Date(value).getTime()/60000);
  const expected=minute(expectedAt);
  return Number.isFinite(expected)&&expected===minute(visibleAt)&&expected===minute(actual);
}
function subscriptionMailFieldsMatch(raw,provider,subject,recipient,visibleSubject,visibleAt) {
  try {
    const lines=subscriptionMailHeaderBlock(raw,provider)?.split(/\r?\n/)||[];
    const field=name=>{const rows=lines.filter(x=>x.slice(0,name.length+1).toLowerCase()===name.toLowerCase()+':');if(rows.length!==1)throw Error('header-field');return rows[0].slice(name.length+1).trim();};
    function decoded(value) {
      return value.replace(/(\?=)[ \t]+(?==\?)/g,'$1').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,(_,charset,encoding,text)=>{
        if(!/^(?:utf-8|us-ascii)$/i.test(charset))throw Error('charset');
        if(encoding.toLowerCase()==='b')return Buffer.from(text,'base64').toString('utf8');
        const bytes=[];text=text.replace(/_/g,' ');
        for(let i=0;i<text.length;i++){if(text[i]==='='){if(!/^[0-9a-f]{2}$/i.test(text.slice(i+1,i+3)))throw Error('encoding');bytes.push(parseInt(text.slice(i+1,i+3),16));i+=2;}else bytes.push(text.charCodeAt(i));}
        return Buffer.from(bytes).toString('utf8');
      });
    }
    const addresses=field('To').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)||[];
    return decoded(field('Subject'))===subject && visibleSubject===subject && addresses.length===1 && addresses[0].toLowerCase()===recipient.toLowerCase() && subscriptionMailTimeMatches(raw,provider,visibleAt,visibleAt);
  } catch {return false;}
}
function subscriptionNaverDateMatches(expected,visibleAt) {
  const m=expected.match(/^(?:([0-9]{4})\.)?([0-9]{2})\.([0-9]{2}) ([0-9]{2}):([0-9]{2})$/);
  if(!m)return false;
  const d=new Date(new Date(visibleAt).getTime()+9*3600000);
  return (!m[1]||Number(m[1])===d.getUTCFullYear()) && Number(m[2])===d.getUTCMonth()+1 && Number(m[3])===d.getUTCDate() && Number(m[4])===d.getUTCHours() && Number(m[5])===d.getUTCMinutes();
}
function subscriptionNaverRows(tree) {
  const counts=[...tree.matchAll(/검색결과 ([0-9]+) 개/g)];
  if(counts.length!==1 || Number(counts[0][1])>100)throw new Error('partial-results');
  const rows=tree.split('\n').filter(x=>/- link "\[.*\]메일 제목/.test(x));
  if(rows.length!==Number(counts[0][1]))throw new Error('partial-results');
  return rows.map(line=>{const name=line.match(/- link "(.*)" \[ref=([^\]]+)\]/);if(!name)throw new Error('partial-results');return {name:name[1],ref:name[2],subject:name[1].split('메일 제목')[1]?.trim()};});
}
function subscriptionEndDate(body) {
    body=body.replace(/\s+/g,' ');
    const markers=[...body.matchAll(/(?:Claude (?:Max|Pro) 이용 기간이|Your (?:Claude )?access (?:will )?ends? on|Your (?:Claude )?subscription (?:will )?(?:ends?|expires?) on)/gi)];
    if(!markers.length)return null;
    const dates=[];
    for(const marker of markers) {
      const m=body.slice(marker.index+marker[0].length).match(/^\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?))\s+([0-9]{1,2}),\s*([0-9]{4})(?![0-9])/i);
      if(!m)return null;
      const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].slice(0,3).toLowerCase());
      const d=new Date(Date.UTC(Number(m[3]),month,Number(m[2])));
      if(Number(m[3])<2020 || d.getUTCFullYear()!==Number(m[3]) || month<0 || d.getUTCMonth()!==month || d.getUTCDate()!==Number(m[2]))return null;
      dates.push(d.toISOString().slice(0,10));
    }
    return new Set(dates).size===1?dates[0]:null;
  }
function subscriptionRawEndDate(raw,provider) {
  try {
    if(raw.length>2097152)throw Error('mime-size');
    const source=provider==='outlook'?raw.replace(/^메시지 원본\r?\n/,''):raw;
    let parts=0;
    function decode(text,encoding) {
      if(encoding==='base64') {
        const compact=text.replace(/\s/g,'');
        if(!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)||compact.length%4)throw Error('mime-encoding');
        return Buffer.from(compact,'base64').toString('utf8');
      }
      if(encoding==='quoted-printable') {
        text=text.replace(/=\r?\n/g,'');const bytes=[];
        for(let i=0;i<text.length;i++) {
          if(text[i]==='='){if(!/^[0-9A-F]{2}$/i.test(text.slice(i+1,i+3)))throw Error('mime-encoding');bytes.push(parseInt(text.slice(i+1,i+3),16));i+=2;}
          else {if(text.charCodeAt(i)>127)throw Error('mime-encoding');bytes.push(text.charCodeAt(i));}
        }
        return Buffer.from(bytes).toString('utf8');
      }
      if(!['','7bit','8bit'].includes(encoding))throw Error('mime-encoding');
      return text;
    }
    function parse(message,depth) {
      if(depth>8||++parts>32)throw Error('mime-depth');
      const boundary=message.match(/\r?\n\r?\n/);if(!boundary)throw Error('mime-shape');
      const lines=message.slice(0,boundary.index).replace(/\r?\n[ \t]+/g,' ').split(/\r?\n/);
      const field=name=>{const rows=lines.filter(x=>x.slice(0,name.length+1).toLowerCase()===name+':');if(rows.length>1)throw Error('mime-header');return rows[0]?.slice(name.length+1).trim()||'';};
      const type=field('content-type')||'text/plain';const body=message.slice(boundary.index+boundary[0].length);
      if(/^multipart\//i.test(type)) {
        const keys=[...type.matchAll(/(?:^|;)\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/gi)];
        if(keys.length!==1)throw Error('mime-boundary');const key=keys[0][1]||keys[0][2];
        if(key.length>70)throw Error('mime-boundary');
        const chunks=[];let current=null,closed=false;
        for(const line of body.split(/\r?\n/)) {
          if(line==='--'+key||line==='--'+key+'--') {
            if(current!==null)chunks.push(current.join('\n'));
            if(line==='--'+key+'--'){closed=true;break;}current=[];
          } else if(current!==null)current.push(line);
        }
        if(!closed||!chunks.length)throw Error('mime-boundary');
        return chunks.flatMap(part=>parse(part,depth+1));
      }
      if(!/^text\/(?:plain|html)(?:;|$)/i.test(type)||/^attachment\b/i.test(field('content-disposition')))return [];
      const charset=type.match(/(?:^|;)\s*charset="?([^;"\s]+)/i)?.[1];
      if(charset&&!/^(?:utf-8|us-ascii)$/i.test(charset))throw Error('mime-charset');
      let text=decode(body,field('content-transfer-encoding').toLowerCase());
      if(text.includes(String.fromCharCode(65533)))throw Error('mime-encoding');
      if(/^text\/html/i.test(type)) {
        text=text.replace(/<!--[^]*?-->/g,' ').replace(/<(script|style)\b[^>]*>[^]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ')
          .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi,x=>({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"})[x.toLowerCase()])
          .replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(_,x)=>String.fromCodePoint(parseInt(x[0].toLowerCase()==='x'?x.slice(1):x,x[0].toLowerCase()==='x'?16:10)));
      }
      return [text];
    }
    const values=parse(source,0).map(subscriptionEndDate);
    return values.length && values.every(Boolean) && new Set(values).size===1?values[0]:null;
  } catch{return null;}
}
// Aside REPL 전용. 허용 계정은 부모가 주입하며 자격증명은 전달받지 않는다.
async function collectSubscriptionMail(allowedEmails) {
  const allowed = new Set(allowedEmails.map(x => x.toLowerCase()));
  const output = [];
  const deadline = Date.now()+85000;
  function checkBudget() { if(Date.now()>=deadline) throw new Error('collector-deadline'); }
  async function query(action) {
    checkBudget();
    return await Promise.race([
      action().then(value=>{checkBudget();return value;}),
      sleep(deadline-Date.now()).then(()=>{throw new Error('collector-deadline');})
    ]);
  }
  const mailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const cancelPattern = /^(?:Claude (?:Max|Pro) 구독이 취소되었습니다|Your (?:Claude )?(?:(?:Max|Pro) )?subscription (?:has been |was )?cancel(?:led|ed))[.!]?$/i;
  const joinPattern = /^(?:(?:Claude )?(?:Max|Pro)에 오신 것을 환영합니다|Welcome to (?:Claude )?(?:Max|Pro)|Your (?:Claude )?(?:(?:Max|Pro) )?subscription (?:has been )?(?:resumed|reactivated))[.!]?$/i;
  function kind(subject) {
    const cancel=cancelPattern.test(subject),join=joinPattern.test(subject);
    if(cancel&&join)throw new Error('unknown-event');
    return cancel?'cancel':join?'join':null;
  }
  function classified(subject) {
    subject=subject.trim();
    const value=kind(subject);
    if(value)return value;
    if(/^Claude[.]ai 로그인용 보안 링크 [|] [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(subject))return null;
    if(/^Claude[.]ai의 보안 링크가 도착했습니다(?: [|] [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2})?$/.test(subject))return null;
    if(/^Your receipt from Anthropic,? PBC #[0-9-]+$/.test(subject))return null;
    if(/^Monthly Pulse - (?:January|February|March|April|May|June|July|August|September|October|November|December) 20[0-9]{2}$/.test(subject))return null;
    if(['Announcing Claude Fable 5.1 and Claude Mythos 5.1','Claude Partner Network: Next Steps'].includes(subject))return null;
    throw new Error('unknown-event');
  }
  async function closeOwnedTab(tab) {
    const closing=closeTab(tab);
    await Promise.race([closing,sleep(10000).then(()=>{throw new Error('cleanup-timeout');})]);
  }
  async function boundedTab(action) {
    checkBudget();let abandoned=false;
    const pending=action().then(async tab=>{if(abandoned||Date.now()>=deadline){await closeOwnedTab(tab);throw new Error('collector-deadline');}return tab;});
    try{return await query(()=>pending);}catch(error){abandoned=true;throw error;}
  }
  const endDate=subscriptionEndDate;
  function event(subject, body, sender, recipient, eventAt) {
    const k = classified(subject);
    if (!k) return null;
    return {kind:k, sender, recipient, eventAt, endsOn:k === 'cancel' ? endDate(body) : null};
  }
  async function read(page) { return (await query(()=>snapshot(page, {interactive:true}))).tree; }
  function ref(tree, pattern) {
    const line = tree.split('\n').find(x => pattern.test(x));
    const match = line?.match(/\[ref=([^\]]+)\]/);
    if (!match) throw new Error('shape-changed');
    return match[1];
  }
  async function click(page, tree, pattern) { await query(()=>page.locator(ref(tree, pattern)).click({timeout:5000})); }
  async function loaded(page, predicate) {
    for (let i=0;i<12;i++) {
      const tree = await read(page);
      if (predicate(tree)) return tree;
      await sleep(300); // snapshot이 아직 로딩 중인 경우만 짧게 재조회한다.
    }
    throw new Error('shape-changed');
  }
  function fullKoreanDate(tree) {
    const m = tree.match(/(\d{4})(?:년\s*|-|\.\s*)(\d{1,2})(?:월\s*|-|\.\s*)(\d{1,2})(?:일|\.)?[^\n]*?(오전|오후)\s*(\d{1,2}):(\d{2})/);
    if (!m) throw new Error('missing-mail-date');
    let hour = Number(m[5]) % 12 + (m[4] === '오후' ? 12 : 0);
    return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${String(hour).padStart(2,'0')}:${m[6]}:00+09:00`;
  }
  function reason(error) { return ['sender-unverified','unknown-event','partial-results','shape-changed','mailbox-identity','message-identity','missing-mail-date','recipient-mismatch','list-changed','collector-deadline'].includes(error?.message) ? error.message : 'collector-failed'; }
  function result(email, events, status='ok', error) { return {email, events, status, ...(status==='error'?{reason:reason(error)}:{})}; }

  try {
    const accounts = await query(()=>googleAccounts.list());
    for (const a of accounts.filter(x=>allowed.has(x.email.toLowerCase()))) {
      try {
        async function searchAllGmail() {
          const messages=[],pages=[];let offset=0;
          for(let page=0;page<5;page++) {
            const search=await query(()=>gmail.search(a.accountId,'in:anywhere from:mail.anthropic.com',{offset}));
            if(typeof search?.hasMore!=='boolean'||!Array.isArray(search.results))throw new Error('partial-results');
            const keys=search.results.map(row=>{
              const at=new Date(row.timestamp).getTime();
              if(typeof row.threadId!=='string'||!row.threadId||typeof row.subject!=='string'||row.timestamp==null||!Number.isFinite(at))throw new Error('partial-results');
              return [row.threadId,row.subject,at];
            });
            pages.push([offset,search.hasMore,keys]);messages.push(...search.results);
            if(new Set(messages.map(x=>x.threadId)).size!==messages.length)throw new Error('partial-results');
            if(search.hasMore===false)return {messages,signature:JSON.stringify(pages)};
            if(page===4||!Number.isSafeInteger(search.nextOffset)||search.nextOffset<=offset)throw new Error('partial-results');
            offset=search.nextOffset;
          }
        }
        const initialSearch=await searchAllGmail();
        const messages=initialSearch.messages;
        const candidates=messages.filter(r=>classified(r.subject));
        if (candidates.length>20) throw new Error('partial-results');
        const events = [];
        for (const r of candidates) {
          const thread = await query(()=>gmail.getThread(a.accountId,r.threadId));
          if(thread?.threadId!==r.threadId||thread.raw!==undefined||!Array.isArray(thread.messages)||!thread.messages.length||
             !thread.messages.some(m=>m.subject===r.subject&&Math.abs(new Date(m.timestamp).getTime()-new Date(r.timestamp).getTime())<1000))throw new Error('partial-results');
          for (const m of thread.messages) {
            checkBudget();
            const recipient = m.to.find(t=>t.email.toLowerCase()===a.email.toLowerCase());
            if (!recipient) throw new Error('recipient-mismatch');
            const ev = event(m.subject,m.body,m.from.email,recipient.email,new Date(m.timestamp).toISOString());
            if (ev) events.push({...ev,subject:m.subject,messageId:m.messageId,threadId:r.threadId,singleMessage:thread.messages.length===1});
            if(events.length>20) throw new Error('partial-results');
          }
        }
        if(events.length) {
          events.sort((x,y)=>new Date(x.eventAt)-new Date(y.eventAt));
          const latest=events[events.length-1];
          if(events.some(x=>x.eventAt===latest.eventAt&&(x.kind!==latest.kind||x.endsOn!==latest.endsOn))) throw new Error('partial-results');
          if(!latest.singleMessage || typeof latest.messageId!=='string' || !latest.messageId)throw new Error('partial-results');
          let authTab;
          try {
            if((await query(()=>listBrowserTabs())).some(t=>/^https:\/\/mail\.google\.com\//.test(t.url))) throw new Error('mailbox-busy');
            authTab=await boundedTab(()=>gmail.openThreadDetailsPage(a.accountId,latest.threadId));
            let authTree=await read(authTab);
            await click(authTab,authTree,/- button "세부정보 표시"/);
            if(await query(()=>authTab.locator('table.ajC').count())!==1)throw new Error('sender-unverified');
            await query(()=>snapshot(authTab,{selector:'table.ajC'}));
            const rows=await query(()=>authTab.locator('table.ajC').evaluate(table=>Array.from(table.rows).map(row=>Array.from(row.cells).map(cell=>cell.innerText))));
            function field(label) {
              const matches=rows.filter(row=>row.length===2 && row[0].trim()===label);
              if(matches.length!==1)throw new Error('sender-unverified');
              return matches[0][1].trim();
            }
            const verifiedSender=field('보낸사람:').match(mailPattern)?.[0];
            const recipients=field('받는 사람:').match(mailPattern)||[];
            if(recipients.length!==1 || recipients[0].toLowerCase()!==a.email.toLowerCase() || !verifiedSender?.toLowerCase().endsWith('@mail.anthropic.com') || field('제목:')!==latest.subject || field('인증기관:')!=='mail.anthropic.com')throw new Error('sender-unverified');
            if(Math.floor(new Date(fullKoreanDate(field('날짜:'))).getTime()/60000)!==Math.floor(new Date(latest.eventAt).getTime()/60000))throw new Error('message-identity');
            const messageRows=await query(()=>authTab.locator('[data-message-id]').evaluateAll(items=>items.map(x=>({id:x.getAttribute('data-message-id'),body:x.innerText}))));
            if(messageRows.length!==1 || messageRows[0].id?.replace(/^#/,'')!==latest.messageId || (latest.kind==='cancel' && endDate(messageRows[0].body)!==latest.endsOn))throw new Error('message-identity');
            latest.sender=verifiedSender;
            latest.senderVerified=true;
          } finally {if(authTab)await closeOwnedTab(authTab);}
          delete latest.threadId;delete latest.singleMessage;delete latest.subject;delete latest.messageId;
          if((await searchAllGmail()).signature!==initialSearch.signature)throw new Error('partial-results');
          output.push(result(a.email,[latest]));
        } else {
          if((await searchAllGmail()).signature!==initialSearch.signature)throw new Error('partial-results');
          output.push(result(a.email,[]));
        }
      } catch (error) { output.push(result(a.email,[],error?.message==='mailbox-busy'?'busy':'error',error)); }
    }
  } catch { output.push({domain:'google',status:'error',events:[]}); }

  // 기존 사용자 탭이 있으면 건드리지 않고 이번 회차를 보류한다.
  async function withMailbox(domain, url, operation) {
    const domains = domain === 'outlook' ? ['outlook.kr','outlook.com','hotmail.com','live.com'] : [domain];
    if (!allowedEmails.some(x=>domains.includes(x.toLowerCase().split('@')[1]))) return;
    if ((await query(()=>listBrowserTabs())).some(t=>typeof t.url==='string' && t.url.match(/^https?:\/\/([^/]+)/)?.[1] === url.match(/^https?:\/\/([^/]+)/)?.[1])) {
      output.push({domain,status:'busy',events:[]}); return;
    }
    let owned;
    try {
      if(deadline-Date.now()<30000) throw new Error('collector-deadline');
      owned = await boundedTab(()=>openTab(url));
      checkBudget();
      await operation(owned);
    } catch (error) { output.push({domain,status:'error',events:[],reason:reason(error)}); }
    finally { if (owned) await closeOwnedTab(owned); }
  }

  await withMailbox('naver.com','https://mail.naver.com',async p=>{
    let tree = await read(p);
    if (!/내 프로필 이미지/.test(tree)) { output.push({domain:'naver.com',status:'login-required',events:[]}); return; }
    await click(p,tree,/- link "내 프로필 이미지"/);
    tree = await read(p);
    const profileAddresses=await query(()=>p.locator('#gnb_my_lyr a.gnb_mail_address').evaluateAll(items=>items.map(x=>x.innerText)));
    const email=subscriptionMailboxIdentity(profileAddresses,[...allowed]);
    if(!email)throw new Error('mailbox-identity');
    await click(p,tree,/- link "내 프로필 이미지"/);
    tree = await read(p);
    await query(()=>p.locator(ref(tree,/- textbox "메일 검색"/)).fill('mail.anthropic.com',{timeout:5000}));
    tree = await read(p);
    await click(p,tree,/- link "보낸사람 검색 mail.anthropic.com"/);
    tree = await loaded(p,t=>/검색결과 \d+ 개/.test(t)&&!/- checkbox "전체 메일"[^\n]*\[disabled\]/.test(t));
    if (!/- button "다음 페이지"[^\n]*\[disabled\]/.test(tree)) throw new Error('partial-results');
    async function completeNaverList(currentTree) {
      const all=subscriptionNaverRows(currentTree);
      for(const row of all) {
        row.key=await query(()=>p.locator(row.ref).getAttribute('href'));
        if(!row.key)throw new Error('partial-results');
      }
      if(new Set(all.map(x=>x.key)).size!==all.length)throw new Error('partial-results');
      return all;
    }
    const initialRows=await completeNaverList(tree);
    const signature=rows=>JSON.stringify(rows.map(x=>[x.key,x.subject]));
    const initialSignature=signature(initialRows);
    const names=initialRows.filter(x=>classified(x.subject)).map(x=>x.name);
    if (names.length>12) throw new Error('partial-results');
    const titles=names.map(x=>x.split('메일 제목')[1]?.trim());
    if(titles.some(x=>!x) || new Set(titles).size!==titles.length)throw new Error('message-identity');
    const events=[];
    for (let i=0;i<names.length;i++) {
      const name=names[i];
      if(signature(await completeNaverList(tree))!==initialSignature)throw new Error('partial-results');
      const current=tree.split('\n').filter(x=>/- link "\[.*\]메일 제목/.test(x)&&classified(x.match(/메일 제목(.*)" \[ref=/)?.[1] ?? x));
      if(current.length!==names.length || !current[i].includes(name)) throw new Error('list-changed');
      const item=p.locator(current[i].match(/\[ref=([^\]]+)\]/)[1]);
      const listDates=await query(()=>item.evaluate(element=>Array.from(element.closest('.mail').parentElement.querySelectorAll('.mail_date_wrap')).map(x=>x.innerText)));
      if(listDates.length!==1)throw new Error('message-identity');
      await query(()=>item.click({timeout:5000}));
      const message=await loaded(p,t=>/받는사람/.test(t)&&/보낸사람/.test(t));
      const from=message.match(/보낸사람"\s*\n\s*- button "[^"\n]*<([^>]+)>/);
      const to=message.match(/받는사람"\s*\n\s*- button "([^"\n]+)"/);
      if (!from||!to) throw new Error('message-identity');
      if(await query(()=>p.locator('h4').count())!==1)throw new Error('shape-changed');
      const titleLines=(await query(()=>p.locator('h4').innerText())).split('\n').map(x=>x.trim());
      const titleStart=titleLines.indexOf('메일 제목');
      if(titleStart<0 || titleLines.lastIndexOf('메일 제목')!==titleStart || titleLines.at(-1)!=='새 창으로 메일 보기')throw new Error('shape-changed');
      const visibleTitle=titleLines.slice(titleStart+1,-1).join('\n');
      const ev=event(titles[i],message,from[1],to[1],fullKoreanDate(message));
      if(!subscriptionNaverDateMatches(listDates[0],ev.eventAt))throw new Error('message-identity');
      await click(p,message,/- button "더보기"/);
      tree=await read(p);await click(p,tree,/- button "원문 보기"/);
      tree=await read(p);
      const raw=await query(()=>p.locator(ref(tree,/- textbox "원문"/)).inputValue());
      if(!subscriptionMailAuthenticatedHeader(raw,'naver')) throw new Error('sender-unverified');
      if(!subscriptionMailFieldsMatch(raw,'naver',titles[i],email,visibleTitle,ev.eventAt) || (ev.kind==='cancel' && subscriptionRawEndDate(raw,'naver')!==ev.endsOn))throw new Error('message-identity');
      ev.eventAt=subscriptionMailTimestamp(raw,'naver');
      if(!ev.eventAt)throw new Error('message-identity');
      ev.senderVerified=true;events.push(ev);
      await click(p,tree,/- button "취소"/);
      tree=await read(p);
      await click(p,tree,/- button "목록"/);
      tree=await loaded(p,t=>/검색결과 \d+ 개/.test(t)&&/- button "다음 페이지"/.test(t));
    }
    tree=await read(p);
    if(signature(await completeNaverList(tree))!==initialSignature)throw new Error('partial-results');
    output.push(result(email,events));
  });

  await withMailbox('outlook','https://outlook.live.com/mail/',async p=>{
    let tree=await loaded(p,t=>/- treeitem "[^"\n]+@/.test(t) || (!/- combobox "전자 메일/.test(t) && /로그인|Sign in/.test(t)));
    const accountRoots=await query(()=>p.locator('[role="treeitem"][aria-level="1"]').evaluateAll(items=>items.filter(x=>x.getAttribute('aria-expanded')!==null).map(x=>x.innerText)));
    const email=subscriptionMailboxIdentity(accountRoots,[...allowed]);
    if(!email){output.push({domain:'outlook',status:'login-required',events:[]});return;}
    // 날짜로 잘라 과거 재가입을 누락하지 않는다.
    const searchQuery='from:mail.anthropic.com';
    const searchRef=ref(tree,/- combobox "전자 메일/);
    await query(()=>p.locator(searchRef).fill(searchQuery,{timeout:5000}));
    tree=await read(p);
    await query(()=>p.locator(ref(tree,/- combobox "전자 메일/)).press('Enter',{timeout:5000}));
    tree=await loaded(p,t=>/검색 결과가 없습니다|결과 없음/.test(t) || (/heading "결과"/.test(t) && /- option "/.test(t)));
    const events=[];
    async function optionRows(currentTree) {
      const options=currentTree.split('\n').filter(x=>/- option "/.test(x));
      if(options.length>20)throw new Error('partial-results');
      const candidates=[],all=[];
      if(!options.length && !/검색 결과가 없습니다|결과 없음/.test(currentTree))throw new Error('partial-results');
      for(const row of options) {
        const optionRef=row.match(/\[ref=([^\]]+)\]/)[1];
        const subjects=await query(()=>p.locator(optionRef).evaluate(element=>Array.from(element.querySelectorAll('span.TtcXM')).map(x=>x.innerText)));
        if(subjects.length!==1)throw new Error('shape-changed');
        const id=await query(()=>p.locator(optionRef).getAttribute('data-convid'));
        if(!id)throw new Error('partial-results');
        all.push([id,subjects[0]]);
        if(classified(subjects[0])){
          const dates=await query(()=>p.locator(optionRef).evaluate(element=>Array.from(element.querySelectorAll('span[title]')).map(x=>x.title).filter(x=>/20[0-9]{2}-[0-9]{2}-[0-9]{2}/.test(x))));
          if(dates.length!==1)throw new Error('message-identity');
          candidates.push({ref:optionRef,id,subject:subjects[0],eventAt:fullKoreanDate(dates[0])});
        }
      }
      if(new Set(all.map(x=>x[0])).size!==all.length || /progressbar|더 많은 결과|추가 결과/.test(currentTree))throw new Error('partial-results');
      if(options.length){
        const complete=await query(()=>p.locator(ref(currentTree,/- listbox "메시지 목록/)).evaluate(element=>{for(let node=element;node;node=node.parentElement){if(node.clientHeight>0&&node.scrollHeight>node.clientHeight+1)return false;}return true;}));
        if(!complete || !/- button "모든 결과"/.test(currentTree))throw new Error('partial-results');
      }
      return {rows:candidates,signature:JSON.stringify([all,candidates.map(x=>[x.subject,x.eventAt])])};
    }
    const initialList=await optionRows(tree);
    const rows=initialList.rows;
    if(rows.length>10) throw new Error('partial-results');
    const subjects=rows.map(x=>x.subject);
    const keys=rows.map(x=>x.eventAt);
    if(new Set(keys).size!==keys.length)throw new Error('message-identity');
    for(let i=0;i<subjects.length;i++) {
      const subject=subjects[i];
      const currentList=await optionRows(tree);
      if(currentList.signature!==initialList.signature)throw new Error('partial-results');
      const current=currentList.rows;
      if(current.length!==subjects.length || current[i].subject!==subject || current[i].eventAt!==rows[i].eventAt) throw new Error('list-changed');
      const previousParts=await query(()=>p.locator('[data-itempart-id]').evaluateAll(es=>es.map(e=>e.getAttribute('data-itempart-id'))));
      await query(()=>p.locator(current[i].ref).click({timeout:5000}));
      const message=await loaded(p,t=>/heading "받는 사람:/.test(t)&&/document "메시지 본문"/.test(t));
      const parts=await query(()=>p.locator('[data-itempart-id]').evaluateAll(es=>es.map(e=>e.getAttribute('data-itempart-id'))));
      if(parts.length!==1||!parts[0]||previousParts.includes(parts[0]))throw new Error('partial-results');
      const partId=parts[0];
      const selected=p.locator('[role="option"][aria-selected="true"]');
      if(await query(()=>selected.count())!==1||await query(()=>selected.getAttribute('data-convid'))!==current[i].id)throw new Error('message-identity');
      const from=message.match(/Anthropic<([^>]+)>/);const to=message.match(/heading "받는 사람: ([^"\n]+)"/);
      if(!from||!to)throw new Error('message-identity');
      const body=message.split('- main "읽기 창"')[1]||'';
      const visibleTitle=body.match(/- heading "([^"\n]+)" \[level=3\]/)?.[1];
      const ev=event(subject,body,from[1],to[1],fullKoreanDate(body));
      const sourceAction=p.locator(ref(message,/- button "More items"/));
      if(await query(()=>sourceAction.evaluate(e=>e.closest('[data-itempart-id]')?.getAttribute('data-itempart-id')))!==partId)throw new Error('message-identity');
      await click(p,message,/- button "More items"/);tree=await read(p);
      await click(p,tree,/- button "보기"/);tree=await read(p);
      await click(p,tree,/- menuitem "메시지 원본 보기"/);tree=await read(p);
      tree=await loaded(p,t=>/- dialog "메시지 원본"/.test(t)&&!/progressbar/.test(t));
      const sourceElement=p.locator('[role="dialog"] .fui-DialogContent.allowTextSelection');
      if(await query(()=>sourceElement.count())!==1)throw new Error('shape-changed');
      const source=await query(()=>sourceElement.innerText());
      if(!subscriptionMailAuthenticatedHeader(source,'outlook'))throw new Error('sender-unverified');
      if(!subscriptionMailTimeMatches(source,'outlook',rows[i].eventAt,ev.eventAt) || !subscriptionMailFieldsMatch(source,'outlook',subject,email,visibleTitle,ev.eventAt) || (ev.kind==='cancel' && subscriptionRawEndDate(source,'outlook')!==ev.endsOn))throw new Error('message-identity');
      const sourceParts=await query(()=>p.locator('[data-itempart-id]').evaluateAll(es=>es.map(e=>e.getAttribute('data-itempart-id'))));
      if(sourceParts.length!==1||sourceParts[0]!==partId)throw new Error('partial-results');
      ev.eventAt=subscriptionMailTimestamp(source,'outlook');
      if(!ev.eventAt)throw new Error('message-identity');
      ev.senderVerified=true;events.push(ev);
      await click(p,tree,/- button "닫기"/);
      // 선택된 항목 이름의 읽음 플래그만 달라지므로 다음 대상을 새 snapshot에서 찾는다.
      tree=await read(p);
    }
    tree=await read(p);
    if((await optionRows(tree)).signature!==initialList.signature)throw new Error('partial-results');
    output.push(result(email,events));
  });
  return output;
}
