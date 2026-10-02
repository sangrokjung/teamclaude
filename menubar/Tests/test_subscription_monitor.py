import copy
import datetime as dt
import importlib.util
import json
import pathlib
import shutil
import pwd
import os
import stat
import subprocess
import tempfile
import unittest
from unittest import mock
import sys
import io
import contextlib
import time
import signal
import fcntl

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('monitor', ROOT / 'scripts/subscription-monitor.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = dt.datetime(2026, 9, 10, tzinfo=dt.timezone.utc)
CONFIG = {'accounts': [{'name': 'test@example.com', 'type': 'oauth', 'accountUuid': 'account-a'}]}
KEY = m.identity('account-a')
CANCEL = {'kind': 'cancel', 'sender': 'billing@mail.anthropic.com', 'recipient': 'test@example.com',
          'eventAt': '2026-09-08T04:40:00Z', 'senderVerified': True, 'endsOn': '2026-09-23'}


def merge(events=None, status='ok', previous=None):
    return m.reconcile(CONFIG, [{'email': 'test@example.com', 'status': status, 'events': events or []}], previous or {}, NOW)



def write_stub(path, body):
    """임시 실행 스크립트를 UTF-8로 쓰고 인코딩을 선언한다.

    본문에 한국어 메일 제목이 실리는데, 선언이 없으면 구버전 python3(Xcode 도구의 3.9)가
    '\\xeb' Non-UTF-8 SyntaxError로 죽는다 (2026-09-24 실측: 네 군데 중 세 군데만 고쳐
    한 건이 남았다 — 그래서 작성 지점을 하나로 모은다).
    """
    path.write_text('#!' + sys.executable + '\n# -*- coding: utf-8 -*-\n' + body, encoding='utf-8')


class MonitorTests(unittest.TestCase):
    def test_identity_is_provider_bound_and_output_has_no_email(self):
        result = merge([CANCEL])
        self.assertNotIn('test@example.com', json.dumps(result))
        self.assertNotIn('billing@', json.dumps(result))
        self.assertEqual(result['accounts'][KEY]['event']['endsOn'], '2026-09-23')

    def test_ambiguous_uuid_email_or_provider_cannot_match(self):
        for other in [CONFIG['accounts'][0], {**CONFIG['accounts'][0], 'accountUuid': 'account-b'}]:
            config = {'accounts': [CONFIG['accounts'][0], other]}
            self.assertEqual(m.configured_accounts(config), [])
        self.assertEqual(m.configured_accounts({'accounts': [{**CONFIG['accounts'][0], 'provider': 'codex'}]}), [])

    def test_sender_recipient_and_dates_fail_closed(self):
        for change in [{'senderVerified': False}, {'sender': 'billing@mail.anthropic.com.evil.test'}, {'sender': 'fake@x@mail.anthropic.com'},
                       {'recipient': 'other@example.com'}, {'endsOn': '2026-02-30'}, {'eventAt': '2027-01-01T00:00:00Z'},
                       {'eventAt': '2026-09-08T01:00:00'}, {'kind': 'unknown'}]:
            row = merge([{**CANCEL, **change}])['accounts'][KEY]
            self.assertEqual(row['status'], 'error', change)
            self.assertNotIn('event', row)
            self.assertNotIn('lastSuccessAt', row)

    def test_join_after_cancel_wins_regardless_of_input_order(self):
        join = {**CANCEL, 'kind': 'join', 'eventAt': '2026-09-09T00:00:00Z'}
        for events in [[join, CANCEL], [CANCEL, join]]:
            event = merge(events)['accounts'][KEY]['event']
            self.assertEqual(event['kind'], 'join')
            self.assertIsNone(event['endsOn'])

    def test_equivalent_timestamp_conflict_is_rejected(self):
        conflict = {**CANCEL, 'kind': 'join', 'eventAt': '2026-09-08T13:40:00+09:00'}
        self.assertEqual(merge([CANCEL, conflict])['accounts'][KEY]['status'], 'error')

    def test_error_busy_login_preserve_success_and_event(self):
        previous = merge([CANCEL])
        for status in ['error', 'busy', 'login-required']:
            row = merge(status=status, previous=previous)['accounts'][KEY]
            self.assertEqual(row['status'], status)
            self.assertEqual(row['event'], previous['accounts'][KEY]['event'])
            self.assertEqual(row['lastSuccessAt'], previous['accounts'][KEY]['lastSuccessAt'])

    def test_partial_invalid_batch_does_not_commit_any_event(self):
        previous = merge([CANCEL])
        bad = {**CANCEL, 'kind': 'join', 'eventAt': '2026-09-09T00:00:00Z', 'recipient': 'other@example.com'}
        row = merge([CANCEL, bad], previous=previous)['accounts'][KEY]
        self.assertEqual(row['status'], 'error')
        self.assertEqual(row['event']['kind'], 'cancel')

    def test_empty_history_cannot_refresh_previous_event(self):
        previous = merge([CANCEL])
        row = merge([], previous=previous)['accounts'][KEY]
        self.assertEqual(row['status'], 'error')
        self.assertEqual(row['lastSuccessAt'], previous['accounts'][KEY]['lastSuccessAt'])

    def test_older_or_conflicting_history_preserves_previous(self):
        previous = merge([{**CANCEL, 'kind': 'join', 'eventAt': '2026-09-09T00:00:00Z'}])
        for event in [CANCEL, {**CANCEL, 'eventAt': '2026-09-09T00:00:00Z'}]:
            row = merge([event], previous=previous)['accounts'][KEY]
            self.assertEqual(row['status'], 'error')
            self.assertEqual(row['event']['kind'], 'join')

    def test_unsupported_mailbox_is_not_reported_as_login_fixable(self):
        config={'accounts':[{**CONFIG['accounts'][0],'name':'test@nate.com'}]}
        row=m.reconcile(config,[],{},NOW)['accounts'][KEY]
        self.assertEqual(row['status'],'unsupported')

    def test_duplicate_mailboxes_fail(self):
        mailbox = {'email': 'test@example.com', 'status': 'ok', 'events': [CANCEL]}
        row = m.reconcile(CONFIG, [mailbox, mailbox], {}, NOW)['accounts'][KEY]
        self.assertEqual(row['status'], 'error')

    def test_repeated_success_is_idempotent(self):
        first = merge([CANCEL])
        before = copy.deepcopy(first)
        self.assertEqual(merge([CANCEL], previous=first), first)
        self.assertEqual(first, before)

    def test_domain_login_required_is_not_error(self):
        row = m.reconcile(CONFIG, [{'domain': 'example.com', 'status': 'login-required'}], {}, NOW)['accounts'][KEY]
        self.assertEqual(row['status'], 'login-required')

    def test_microsoft_service_failures_apply_to_supported_domains_only(self):
        for domain in m.MICROSOFT_DOMAINS:
            config = {'accounts': [{**CONFIG['accounts'][0], 'name': 'test@' + domain}]}
            failed = m.reconcile(config, [{'domain': 'outlook', 'status': 'error'}], {}, NOW)
            self.assertEqual(failed['accounts'][KEY]['status'], 'error')
            google = m.reconcile(config, [{'domain': 'google', 'status': 'error'}], {}, NOW)
            self.assertEqual(google['accounts'][KEY]['status'], 'login-required')

    def test_atomic_cache_permissions_and_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'cache.json'
            m.atomic_json(path, merge([CANCEL]))
            m.atomic_json(path, merge([]))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(len(list(path.parent.iterdir())), 1)
            self.assertNotIn('event', json.loads(path.read_text())['accounts'][KEY])

    def collector_fixture(self, subjects=None, count=1, late=False, authenticated=True, ui_recipient=None, ui_subject=None, body=None, ui_body=None, ui_id=None, has_more=False, shift_pages=False, partial_thread=None):
        node = shutil.which('node') or str(pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/node')
        subjects = subjects or ['Claude Max 구독이 취소되었습니다']
        messages = [{'messageId':'msg-fixture','subject': title, 'from': {'email':'billing@mail.anthropic.com'},
            'to':[{'email':'test@example.com'}], 'timestamp':'2026-09-08T04:40:00Z',
            'body':body or 'Claude Max 이용 기간이 Sep 23, 2026에 만료됩니다.'} for title in subjects] * count
        ui_rows = [['보낸사람:', 'Anthropic <billing@mail.anthropic.com>'],
                   ['받는 사람:', ui_recipient or 'test@example.com'],
                   ['날짜:', '2026. 9. 8. 오후 1:40'],
                   ['제목:', ui_subject or subjects[0]]]
        if authenticated:
            ui_rows.append(['인증기관:', 'mail.anthropic.com'])
        message_rows=[{'id':ui_id or '#msg-fixture','body':ui_body or body or 'Claude Max 이용 기간이 Sep 23, 2026에 만료됩니다.'}]
        support = "let clock=0;Date.now=()=>clock;const sleep=()=>new Promise(()=>{});const rows=" + json.dumps(ui_rows,ensure_ascii=False) + ";const messageRows=" + json.dumps(message_rows,ensure_ascii=False) + ";const authPage={locator:()=>({click:async()=>{},count:async()=>1,evaluate:async()=>rows,evaluateAll:async()=>messageRows})};const closeTab=async()=>{};const listBrowserTabs=async()=>[];const snapshot=async()=>({tree:'- button \"세부정보 표시\" [ref=e1]'});const googleAccounts={list:async()=>[{accountId:0,email:'test@example.com'}]};const gmail={openThreadDetailsPage:async()=>authPage,search:async(uid,q)=>{if(q.includes('subject:'))throw Error('narrow-query');return {hasMore:false,results:" + json.dumps([{'subject':title,'threadId':str(i),'timestamp':'2026-09-08T04:40:00Z'} for i,title in enumerate(subjects)],ensure_ascii=False) + "}},getThread:async(uid,id)=>{clock=" + ('90000' if late else '0') + ";return {threadId:id,messages:(" + json.dumps(messages,ensure_ascii=False) + ").filter(m=>m.subject===" + json.dumps(subjects,ensure_ascii=False) + "[Number(id)])}}};"
        support = support.replace('hasMore:false', 'hasMore:' + ('undefined' if has_more == 'missing' else json.dumps(has_more)))
        if partial_thread:
            support += "const originalThread=gmail.getThread;gmail.getThread=async(uid,id)=>{const thread=await originalThread(uid,id);if(id==='1'){thread.messages=" + ("[]" if partial_thread == 'empty' else "thread.messages.map(m=>({...m,timestamp:'2026-09-07T04:40:00Z'}))") + ";}return thread;};"
        if shift_pages:
            support += "let searchCalls=0;const originalSearch=gmail.search;gmail.search=async(...args)=>{const original=await originalSearch(...args);const n=searchCalls++;if(n===0)return {results:[...original.results,{threadId:'receipt',subject:'Your receipt from Anthropic PBC #123',timestamp:'2026-09-07T00:00:00Z'}],hasMore:true,nextOffset:2};if(n===1)return {results:[],hasMore:false};return {results:[...original.results,{threadId:'new-join',subject:'Welcome to Max',timestamp:'2026-09-09T00:00:00Z'}],hasMore:false};};"
        with tempfile.TemporaryDirectory() as directory:
            fake = pathlib.Path(directory) / 'aside'
            write_stub(fake, 'import os,sys\ncode=sys.stdin.read()\nos.execv(' + repr(node) + ',[' + repr(node) + ',"--input-type=module","-e",' + repr(support) + '+code])\n')
            fake.chmod(0o700)
            with mock.patch.object(m.shutil, 'which', return_value=str(fake)):
                return m.collect(m.configured_accounts(CONFIG))

    def test_real_collector_stdin_protocol_with_mock_mailbox(self):
        result = self.collector_fixture()
        self.assertEqual(result[0]['status'], 'ok')
        self.assertEqual(result[0]['events'][0]['endsOn'], '2026-09-23')

    def test_gmail_missing_or_stale_rejoin_thread_preserves_history(self):
        for partial in ['empty', 'stale']:
            result = self.collector_fixture(['Claude Max 구독이 취소되었습니다', 'Welcome to Max'], partial_thread=partial)
            self.assertEqual(result[0]['status'], 'error')
            self.assertEqual(result[0]['reason'], 'partial-results')
            previous = merge([CANCEL])
            current = m.reconcile(CONFIG, result, previous, NOW + dt.timedelta(hours=1))['accounts'][KEY]
            self.assertEqual(current['lastSuccessAt'], previous['accounts'][KEY]['lastSuccessAt'])
            self.assertEqual(current['event'], previous['accounts'][KEY]['event'])

    def test_gmail_requires_explicit_complete_pagination(self):
        for value in [None, 0, 'false', 'missing']:
            result = self.collector_fixture(has_more=value)
            self.assertEqual(result[0]['status'], 'error')
            self.assertEqual(result[0]['reason'], 'partial-results')
            previous = merge([CANCEL])
            current = m.reconcile(CONFIG, result, previous, NOW + dt.timedelta(hours=1))['accounts'][KEY]
            self.assertEqual(current['lastSuccessAt'], previous['accounts'][KEY]['lastSuccessAt'])

    def test_gmail_page_shift_cannot_skip_newer_rejoin(self):
        result = self.collector_fixture(shift_pages=True)
        self.assertEqual(result[0]['status'], 'error')
        self.assertEqual(result[0]['reason'], 'partial-results')
        previous = merge([CANCEL])
        current = m.reconcile(CONFIG, result, previous, NOW + dt.timedelta(hours=1))['accounts'][KEY]
        self.assertEqual(current['lastSuccessAt'], previous['accounts'][KEY]['lastSuccessAt'])
        self.assertEqual(current['event'], previous['accounts'][KEY]['event'])

    def test_authenticated_raw_timestamp_preserves_seconds(self):
        node = shutil.which('node') or str(pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/node')
        source = (ROOT/'scripts/subscription-monitor-browser.js').read_text()
        raw = 'Received: by receiver\nDate: Wed, 9 Sep 2026 04:40:50 +0000\n\nbody'
        code = source + '\nconst raw=' + json.dumps(raw) + ';console.log(JSON.stringify([subscriptionMailTimestamp(raw,"naver"),subscriptionMailTimestamp(raw,"outlook")]));'
        result = subprocess.run([node, '--input-type=module', '-e', code], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ['2026-09-09T04:40:50.000Z'] * 2)

    def test_collector_unknown_subscription_cannot_refresh_old_cancellation(self):
        for unknown in ['Your Claude subscription has been renewed', 'Your Claude subscription has been restarted', 'Your Claude plan was renewed', 'Your Claude plan has been restarted', 'Your Claude subscription changed: sign in']:
            result = self.collector_fixture(['Claude Max 구독이 취소되었습니다',unknown])
            self.assertEqual(result[0]['status'], 'error')
            self.assertEqual(result[0]['reason'], 'unknown-event')
            previous = merge([CANCEL])
            row = m.reconcile(CONFIG,result,previous,NOW)['accounts'][KEY]
            self.assertEqual(row['event'],previous['accounts'][KEY]['event'])
            self.assertEqual(row['lastSuccessAt'],previous['accounts'][KEY]['lastSuccessAt'])

    def test_receiver_authentication_header_boundary(self):
        node=shutil.which('node') or str(pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/node')
        source=(ROOT/'scripts/subscription-monitor-browser.js').read_text()
        prefix='Received: from sender by mx.naver.com; Wed, 9 Sep 2026 12:00:00 +0900\r\n'
        auth='Authentication-Results: mx.naver.com; dmarc=pass header.from=mail.anthropic.com; dkim=pass\r\n'
        cases=[(prefix+auth+'\r\nbody', 'naver', True),
               (prefix+'From: billing@mail.anthropic.com\r\n\r\n'+auth, 'naver', False),
               (prefix+auth+auth+'\r\nbody', 'naver', False),
               (prefix+auth.replace('mx.naver.com','fake.example.com')+'\r\nbody','naver',False),
               (prefix+auth.replace('dmarc=pass','dmarc=fail')+'\r\nbody','naver',False),
               (prefix+auth.replace('mail.anthropic.com','mail.anthropic.com.evil.example')+'\r\nbody','naver',False)]
        code=source+'\nconst cases='+json.dumps(cases)+';console.log(JSON.stringify(cases.map(x=>subscriptionMailAuthenticatedHeader(x[0],x[1]))));'
        r=subprocess.run([node,'--input-type=module','-e',code],capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(json.loads(r.stdout),[x[2] for x in cases])

    def test_exact_official_from_without_verified_signature_is_rejected(self):
        result=self.collector_fixture(authenticated=False)
        self.assertEqual(result[0]['status'],'error')
        self.assertEqual(result[0]['reason'],'sender-unverified')

    def outlook_changed_list_preserves_previous(self, date_only=False, stale_pane=False, grouped=False):
        node=shutil.which('node') or str(pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/node')
        support=r"""
const sleep=()=>new Promise(()=>{}),googleAccounts={list:async()=>[]},listBrowserTabs=async()=>[],closeTab=async()=>{};
let searched=false,active=null,rows=[{id:'old-cancel',subject:'Claude Max 구독이 취소되었습니다',date:'화 2026-09-08 오후 1:40'},{id:'old-join',subject:'Max에 오신 것을 환영합니다',date:'월 2026-09-07 오후 1:40'}];
const raw='Received: by mx.microsoft.com\nAuthentication-Results: mx.microsoft.com 1; dmarc=pass header.from=mail.anthropic.com; compauth=pass\nSubject: Claude Max 구독이 취소되었습니다\nTo: test@outlook.com\nDate: Tue, 8 Sep 2026 04:40:00 +0000\nContent-Type: text/plain; charset=UTF-8\n\nYour access ends on Sep 23, 2026.';
const p={locator:ref=>({
 fill:async()=>{},count:async()=>1,press:async()=>{searched=true;},getAttribute:async()=>ref.startsWith('[role=')?active?.id:rows[Number(ref.slice(1))]?.id,
 evaluateAll:async()=>ref==='[data-itempart-id]'?(active?[active.id+'-part']:[]):['test@outlook.com'],
 evaluate:async fn=>{const code=fn.toString();if(code.includes('closest'))return active.id+'-part';if(code.includes('span.TtcXM'))return [rows[Number(ref.slice(1))].subject];if(code.includes('span[title]'))return [rows[Number(ref.slice(1))].date];return true;},
 innerText:async()=>{if(ref!=='[role="dialog"] .fui-DialogContent.allowTextSelection')throw Error('dialog-chrome-is-not-source');return active.subject.includes('환영')?raw.replace('Claude Max 구독이 취소되었습니다',active.subject).replace('Tue, 8 Sep 2026','Mon, 7 Sep 2026'):raw;},
 click:async()=>{if(/^r[0-9]+$/.test(ref))active=rows[Number(ref.slice(1))];if(ref==='close'){rows[0]={id:'new-join',subject:'Max에 오신 것을 환영합니다',date:'수 2026-09-09 오후 1:40'};active=null;}}
})};
const openTab=async()=>p;
const snapshot=async()=>({tree:'- treeitem "test@outlook.com" [ref=root]\n- combobox "전자 메일 검색" [ref=search]\n'+(searched?'- heading "결과"\n- listbox "메시지 목록" [ref=list]\n- button "모든 결과" [ref=all]\n'+rows.map((x,i)=>'- option "'+x.subject+'" [ref=r'+i+']').join('\n'):'')+(active?'\n- main "읽기 창":\n - heading "'+active.subject+'" [level=3]\n - button "Anthropic<billing@mail.anthropic.com>"\n - heading "받는 사람: test@outlook.com"\n - heading "'+active.date+'" [level=3]\n - document "메시지 본문"\n - text: "Your access ends on Sep 23, 2026."\n - button "More items" [ref=more]\n - button "보기" [ref=view]\n - menuitem "메시지 원본 보기" [ref=source]\n - dialog "메시지 원본"\n - button "닫기" [ref=close]':'')});
"""
        if date_only:
            support = support.replace('let searched=false,active=null,rows=', 'let closed=0,searched=false,active=null,rows=')
            support = support.replace("rows[0]={id:'new-join',subject:'Max에 오신 것을 환영합니다',date:'수 2026-09-09 오후 1:40'};active=null;", "if(++closed===2)rows[1].date='수 2026-09-09 오후 1:40';active=null;")
        if stale_pane:
            support = support.replace('active=null,rows=', "active={id:'old-cancel',subject:'Claude Max 구독이 취소되었습니다',date:'화 2026-09-08 오후 1:40'},rows=", 1)
        if grouped:
            support = support.replace("active?[active.id+'-part']:[]", "active?[active.id+'-part',active.id+'-other-same-minute']:[]")
        config={'accounts':[{**CONFIG['accounts'][0],'name':'test@outlook.com'}]}
        with tempfile.TemporaryDirectory() as directory:
            fake=pathlib.Path(directory)/'aside'
            write_stub(fake, 'import os,sys\ncode=sys.stdin.read()\nos.execv('+repr(node)+',['+repr(node)+',"--input-type=module","-e",'+repr(support)+'+code])\n');fake.chmod(0o700)
            with mock.patch.object(m.shutil,'which',return_value=str(fake)):
                result=m.collect(m.configured_accounts(config))
        self.assertEqual(result[-1]['status'],'error')
        self.assertEqual(result[-1]['reason'],'partial-results')
        previous=merge([CANCEL])
        row=m.reconcile(config,result,previous,NOW)['accounts'][KEY]
        self.assertEqual(row['event'],previous['accounts'][KEY]['event'])
        self.assertEqual(row['lastSuccessAt'],previous['accounts'][KEY]['lastSuccessAt'])

    def test_outlook_already_read_row_replaced_by_rejoin_preserves_previous(self):
        self.outlook_changed_list_preserves_previous()

    def test_outlook_same_conversation_newer_join_date_preserves_previous(self):
        self.outlook_changed_list_preserves_previous(date_only=True)

    def test_outlook_stale_pane_and_multiple_message_parts_are_rejected(self):
        self.outlook_changed_list_preserves_previous(stale_pane=True)
        self.outlook_changed_list_preserves_previous(grouped=True)

    def test_raw_calendar_date_cannot_be_normalized_into_another_day(self):
        node=shutil.which('node') or str(pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/node')
        source=(ROOT/'scripts/subscription-monitor-browser.js').read_text()
        values=['Tue, 31 Feb 2026 04:40:50 +0000','Tue, 30 Feb 2026 04:40:50 +0000','Tue, 8 Sep 2026 24:40:50 +0000','Tue, 8 Sep 2026 04:40:50 +2460']
        code=source+'\nconst values='+json.dumps(values)+';console.log(JSON.stringify(values.map(v=>subscriptionMailTimestamp("Date: "+v+"\\n\\nbody","naver"))));'
        r=subprocess.run([node,'--input-type=module','-e',code],capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(json.loads(r.stdout),[None]*len(values))

    def test_custom_google_domain_failure_is_not_login_expiry(self):
        row=m.reconcile(CONFIG,[{'domain':'google','status':'error'}],merge([CANCEL]),NOW)['accounts'][KEY]
        self.assertEqual(row['status'],'error')
        self.assertEqual(row['lastSuccessAt'],NOW.isoformat())

    def test_authenticated_mime_body_date_cannot_use_stale_visible_body(self):
        node=shutil.which('node') or str(pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/node')
        source=(ROOT/'scripts/subscription-monitor-browser.js').read_text()
        code=source+"""
const plain='Your access ends on Sep 23, 2026.';
const html='<p>Your access ends on <b>Sep 23, 2026</b>.</p>';
const part=(type,body)=>'Content-Type: '+type+'; charset=UTF-8\\nContent-Transfer-Encoding: base64\\n\\n'+Buffer.from(body).toString('base64');
const multi='Content-Type: multipart/alternative; boundary="abc"\\n\\n--abc\\n'+part('text/plain',plain)+'\\n--abc\\n'+part('text/html',html)+'\\n--abc--';
const conflict=multi.replace(Buffer.from(html).toString('base64'),Buffer.from(html.replace('23','10')).toString('base64'));
console.log(JSON.stringify([
 subscriptionRawEndDate(multi,'naver'),
 subscriptionRawEndDate('메시지 원본\\n'+multi,'outlook'),
 subscriptionRawEndDate(conflict,'naver'),
 subscriptionEndDate('Your access ends on Sep 23, 0000'),
 subscriptionEndDate('Your access ends on Sep 23, 0099')
]));
"""
        r=subprocess.run([node,'--input-type=module','-e',code],capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(json.loads(r.stdout),['2026-09-23','2026-09-23',None,None,None])

    def test_subscription_end_date_ignores_links_and_rejects_conflicts(self):
        body='Your download link expires on Sep 10, 2026. Your access ends on Sep 23, 2026.'
        result=self.collector_fixture(body=body)
        self.assertEqual(result[0]['events'][0]['endsOn'],'2026-09-23')
        for body in ['Your download link expires on Sep 10, 2026.',
                     'Your access ends on Sep 10, 2026. Your access ends on Sep 23, 2026.']:
            result=self.collector_fixture(body=body)
            row=m.reconcile(CONFIG,result,merge([CANCEL]),NOW)['accounts'][KEY]
            self.assertEqual(row['status'],'error')
            self.assertEqual(row['event']['endsOn'],'2026-09-23')

    def test_naver_total_cannot_hide_newer_or_unrecognized_rows(self):
        node=shutil.which('node') or str(pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/node')
        source=(ROOT/'scripts/subscription-monitor-browser.js').read_text()
        one='검색결과 2 개\n- link "[읽음]메일 제목Claude Max 구독이 취소되었습니다" [ref=e1]'
        malformed=one+'\n- link "새로운 형식의 재가입" [ref=e2]'
        complete=one+'\n- link "[읽지 않음]메일 제목Max에 오신 것을 환영합니다" [ref=e2]'
        code=source+'\nconst inputs='+json.dumps([one,malformed,complete],ensure_ascii=False)+';console.log(JSON.stringify(inputs.map(x=>{try{return subscriptionNaverRows(x).length;}catch{return "partial-results";}})));'
        r=subprocess.run([node,'--input-type=module','-e',code],capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(json.loads(r.stdout),['partial-results','partial-results',2])

    def test_gmail_requires_exact_subject_id_and_visible_end_date(self):
        for change in [{'ui_subject':'Claude Pro 구독이 취소되었습니다'}, {'ui_id':'#another-message'},
                       {'ui_body':'Claude Max 이용 기간이 Sep 24, 2026에 만료됩니다.'}]:
            result=self.collector_fixture(**change)
            self.assertEqual(result[0]['status'],'error',change)
        for body in ['access ends on Sepgarbage 23, 2026','access ends on Sep 23, 20260']:
            result=self.collector_fixture(body=body)
            row=m.reconcile(CONFIG,result,merge([CANCEL]),NOW)['accounts'][KEY]
            self.assertEqual(row['status'],'error')
        for subject in ['Your Claude subscription was cancelled, but your subscription has been reactivated',
                        'Your Claude subscription was not cancelled']:
            result=self.collector_fixture([subject])
            self.assertEqual(result[0]['status'],'error')

    def test_authentication_quoted_comments_and_conflicts_cannot_supply_pass(self):
        node=shutil.which('node') or str(pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/node')
        source=(ROOT/'scripts/subscription-monitor-browser.js').read_text()
        cases=[]
        for provider,server in [('naver','mx.naver.com'),('outlook','mx.microsoft.com 1')]:
            for auth in ['dmarc=fail reason="; dmarc=pass header.from=mail.anthropic.com; compauth=pass"',
                         'dmarc=fail (reason ; dmarc=pass header.from=mail.anthropic.com; compauth=pass)',
                         'dmarc=pass header.from=mail.anthropic.com; dmarc=fail; compauth=pass']:
                cases.append(['Received: by receiver\r\nAuthentication-Results: '+server+'; '+auth+'\r\n\r\nbody',provider])
        code=source+'\nconst cases='+json.dumps(cases)+';console.log(JSON.stringify(cases.map(x=>subscriptionMailAuthenticatedHeader(x[0],x[1]))));'
        r=subprocess.run([node,'--input-type=module','-e',code],capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(json.loads(r.stdout),[False]*len(cases))

    def test_message_subject_recipient_and_header_bind_to_visible_mail(self):
        node=shutil.which('node') or str(pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/node')
        source=(ROOT/'scripts/subscription-monitor-browser.js').read_text()
        code=source+"""
const subject='Claude Max 구독이 취소되었습니다';
const raw='Received: by receiver\\nSubject: =?UTF-8?B?'+Buffer.from(subject).toString('base64')+'?=\\nTo: test@example.com\\nDate: Tue, 8 Sep 2026 04:40:00 +0000\\n\\nbody';
const at='2026-09-08T13:40:00+09:00';
console.log(JSON.stringify([
 subscriptionMailFieldsMatch(raw,'naver',subject,'test@example.com',subject,at),
 subscriptionMailFieldsMatch(raw,'naver','Max에 오신 것을 환영합니다','test@example.com',subject,at),
 subscriptionMailFieldsMatch(raw,'outlook',subject,'test@example.com','다른 메일',at),
 subscriptionMailFieldsMatch(raw,'outlook',subject,'other@example.com',subject,at),
 subscriptionNaverDateMatches('09.08 13:40',at),
 subscriptionNaverDateMatches('09.08 13:41',at)
]));
"""
        r=subprocess.run([node,'--input-type=module','-e',code],capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(json.loads(r.stdout),[True,False,False,False,True,False])

    def test_exited_cli_leader_cannot_leave_lock_holding_descendant(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = pathlib.Path(directory)
            pidfile = folder/'descendant.pid'
            fake = folder/'aside'
            write_stub(fake, 'import os,sys,time,signal\nsys.stdin.read()\npid=os.fork()\nif pid==0:\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n for fd in [0,1,2]:os.close(fd)\n time.sleep(60)\nelse:\n open(' + repr(str(pidfile)) + ',"w").write(str(pid))\n print("SUBSCRIPTION_RESULT=[]",flush=True)\n')
            fake.chmod(0o700)
            child = None
            try:
                with (folder/'lock').open('a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                    with mock.patch.object(m.shutil, 'which', return_value=str(fake)):
                        self.assertEqual(m.collect(m.configured_accounts(CONFIG), lock_fd=lock.fileno()), [])
                child = int(pidfile.read_text())
                with (folder/'lock').open('a') as probe:
                    deadline = time.monotonic() + 2
                    while True:
                        try:
                            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            break
                        except BlockingIOError:
                            if time.monotonic() >= deadline:
                                self.fail('CLI 리더 종료 후 남은 자식이 잠금을 계속 보유함')
                            time.sleep(0.02)
            finally:
                if child is None and pidfile.exists():child = int(pidfile.read_text())
                if child:
                    try:os.kill(child, signal.SIGKILL)
                    except ProcessLookupError:pass

    def test_parent_termination_cannot_release_lock_while_child_collects(self):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            with tempfile.TemporaryDirectory() as directory:
                folder=pathlib.Path(directory);pidfile=folder/'pid';lockfile=folder/'lock';fake=folder/'aside'
                write_stub(fake, 'import os,time,pathlib\npathlib.Path('+repr(str(pidfile))+').write_text(str(os.getpid()))\ntime.sleep(60)\n')
                fake.chmod(0o700)
                code="import importlib.util,fcntl; s=importlib.util.spec_from_file_location('monitor',"+repr(str(ROOT/'scripts/subscription-monitor.py'))+");m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.shutil.which=lambda _:"+repr(str(fake))+";f=open("+repr(str(lockfile))+",'w');fcntl.flock(f,fcntl.LOCK_EX);m.collect([],lock_fd=f.fileno())"
                parent=subprocess.Popen([sys.executable,'-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                child=None
                try:
                    until=time.monotonic()+10
                    while not pidfile.exists() and time.monotonic()<until:time.sleep(.02)
                    self.assertTrue(pidfile.exists());child=int(pidfile.read_text())
                    with lockfile.open('a') as lock:
                        with self.assertRaises(BlockingIOError):fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                        parent.send_signal(sig);parent.wait(timeout=10)
                        if sig==signal.SIGKILL:
                            with self.assertRaises(BlockingIOError):fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                            os.killpg(child,signal.SIGTERM)
                        until=time.monotonic()+5
                        while True:
                            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
                            except BlockingIOError:
                                if time.monotonic()>=until:raise
                                time.sleep(.02)
                finally:
                    if parent.poll() is None:parent.kill()
                    if child:
                        try:os.killpg(child,signal.SIGTERM)
                        except ProcessLookupError:pass
                    parent.communicate(timeout=5)

    def test_mailbox_identity_and_stale_reading_pane_fail_closed(self):
        node=shutil.which('node') or str(pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/node')
        source=(ROOT/'scripts/subscription-monitor-browser.js').read_text()
        code=source+"""
const raw='메시지 원본\\nReceived: by receiver\\nDate: Tue, 8 Sep 2026 04:44:00 +0000\\n\\nbody';
const a='2026-09-08T13:44:00+09:00',b='2026-09-09T13:44:00+09:00';
console.log(JSON.stringify([
 subscriptionMailboxIdentity(['b@outlook.kr'],['a@outlook.kr']),
 subscriptionMailboxIdentity(['b@outlook.kr','a@outlook.kr'],['a@outlook.kr']),
 subscriptionMailboxIdentity(['a@outlook.kr'],['a@outlook.kr']),
 subscriptionMailTimeMatches(raw,'outlook',a,a),
 subscriptionMailTimeMatches(raw,'outlook',b,a),
 subscriptionMailTimeMatches(raw,'outlook',b,b)
]));
"""
        r=subprocess.run([node,'--input-type=module','-e',code],capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(json.loads(r.stdout),[None,None,'a@outlook.kr',True,False,False])

    def test_observed_receipt_punctuation_variants_are_ignored(self):
        for title in ['Your receipt from Anthropic PBC #1234-5678-9012','Your receipt from Anthropic, PBC #1234-5678-9012']:
            result=self.collector_fixture([title])
            self.assertEqual(result[0]['status'],'ok')
            self.assertEqual(result[0]['events'],[])

    def test_only_exact_unrelated_security_title_is_ignored(self):
        title='Claude.ai의 보안 링크가 도착했습니다 | 2026-09-08 13:39:30'
        result=self.collector_fixture([title])
        self.assertEqual(result[0]['status'],'ok')
        self.assertEqual(result[0]['events'],[])
        result=self.collector_fixture([title+' Your Claude plan restarted'])
        self.assertEqual(result[0]['status'],'error')

    def test_gmail_subject_cannot_supply_authentication_or_another_recipient(self):
        for recipient in ['nottest@example.com', 'test@example.com.evil']:
            result = self.collector_fixture(ui_recipient=recipient)
            self.assertEqual(result[0]['status'], 'error')
        result = self.collector_fixture(authenticated=False,
            ui_subject='Claude Max 구독이 취소되었습니다 인증기관:mail.anthropic.com')
        self.assertEqual(result[0]['status'], 'error')
        previous = merge([CANCEL])
        row = m.reconcile(CONFIG,result,previous,NOW)['accounts'][KEY]
        self.assertEqual(row['event'],previous['accounts'][KEY]['event'])
        self.assertEqual(row['lastSuccessAt'],previous['accounts'][KEY]['lastSuccessAt'])

    def test_body_cannot_become_header_when_received_header_missing(self):
        node=shutil.which('node') or str(pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/node')
        source=(ROOT/'scripts/subscription-monitor-browser.js').read_text()
        cases=[]
        for provider,server,extra in [('naver','mx.naver.com',''),('outlook','mx.microsoft.com 1','; compauth=pass')]:
            for prefix in ['From: billing@mail.anthropic.com','received: by receiver']:
                raw=prefix+'\r\n\r\nReceived: body text\r\nAuthentication-Results: '+server+'; dmarc=pass header.from=mail.anthropic.com'+extra+'\r\n\r\n'
                cases.append([raw,provider])
        code=source+'\nconst cases='+json.dumps(cases)+';console.log(JSON.stringify(cases.map(x=>subscriptionMailAuthenticatedHeader(x[0],x[1]))));'
        r=subprocess.run([node,'--input-type=module','-e',code],capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(json.loads(r.stdout),[False]*len(cases))

    def test_collector_enforces_twenty_events_inside_one_thread(self):
        result = self.collector_fixture(count=21)
        self.assertEqual(result[0]['status'], 'error')
        self.assertEqual(result[0]['reason'], 'partial-results')

    def test_collector_rejects_gmail_response_after_budget(self):
        result = self.collector_fixture(late=True)
        self.assertEqual(result[0]['status'], 'error')
        self.assertEqual(result[0]['reason'], 'collector-deadline')

    def test_dry_run_does_not_create_cache_or_mutate_config(self):
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / 'config.json'
            state = pathlib.Path(directory) / 'monitor.json'
            config.write_text(json.dumps(CONFIG))
            original = config.read_bytes()
            with mock.patch.object(m, 'STATE', state), mock.patch.object(m, 'CONFIG', config), mock.patch.object(m, 'collect', return_value=[{'email':'test@example.com','status':'ok','events':[CANCEL]}]), contextlib.redirect_stdout(io.StringIO()) as output:
                m.run(dry_run=True)
            self.assertFalse(state.exists())
            self.assertEqual(config.read_bytes(), original)
            self.assertNotIn('test@example.com', output.getvalue())

    def test_browser_syntax(self):
        node = shutil.which('node') or str(pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.local/bin/node')
        r = subprocess.run([node, '--check', str(ROOT / 'scripts/subscription-monitor-browser.js')], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


class SwiftMonitorTests(unittest.TestCase):
    def test_monitor_overlay_and_visible_failures(self):
        with tempfile.TemporaryDirectory(prefix='subscription-monitor-test-') as directory:
            executable = pathlib.Path(directory) / 'monitor-tests'
            r = subprocess.run(['/usr/bin/swiftc', '-j', '1', '-num-threads', '1',
                str(ROOT / 'menubar/Sources/AccountSubscription.swift'),
                str(ROOT / 'menubar/Sources/AccountSubscriptionButton.swift'),
                str(ROOT / 'menubar/Tests/SubscriptionMonitorTests.swift'), '-framework', 'Cocoa', '-o', str(executable)],
                capture_output=True, text=True, timeout=600)
            self.assertEqual(r.returncode, 0, r.stderr)
            r = subprocess.run([str(executable)], capture_output=True, text=True, timeout=30)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('MONITOR assertions passed', r.stdout)


if __name__ == '__main__' and '--live-surfaces' in sys.argv:
    class LiveSurfaceTests(unittest.TestCase):
        def test_live_mailboxes_and_browser_tab_cleanup(self):
            aside = shutil.which('aside')
            self.assertTrue(aside and pathlib.Path(aside).is_file(), 'real-aside-required')
            # 주소·탭 URL은 비교할 때만 메모리에 유지하며 실패 출력에도 넣지 않는다.
            def tabs_now():
                code = 'console.log("TAB_AUDIT="+JSON.stringify(await listBrowserTabs()));'
                r = subprocess.run([aside, 'repl'], input=code + chr(10),
                                   capture_output=True, text=True, timeout=30)
                self.assertEqual(r.returncode, 0, 'aside-tab-inventory-failed')
                lines = [x.split('TAB_AUDIT=', 1)[1] for x in r.stdout.splitlines()
                         if 'TAB_AUDIT=' in x and x.split('TAB_AUDIT=', 1)[1].startswith('[')]
                self.assertEqual(len(lines), 1, 'aside-tab-inventory-missing')
                try:
                    return {x['targetId']: (x.get('url'), x.get('title')) for x in json.loads(lines[0])}
                except (ValueError, KeyError, TypeError):
                    self.fail('aside-tab-inventory-invalid')
            before = tabs_now()
            try:
                r = subprocess.run([sys.executable, str(ROOT / 'scripts/subscription-monitor.py'), '--dry-run'],
                                   cwd=ROOT, capture_output=True, text=True, timeout=600)
                self.assertEqual(r.returncode, 0, 'live-mail-dry-run-failed')
                try:
                    result = json.loads(r.stdout)
                except ValueError:
                    self.fail('live-mail-result-invalid')
                self.assertIs(result.get('dryRun'), True, 'live-mail-dry-run-missing')
                config = json.loads(m.CONFIG.read_text())
                accounts = {a['index']: a for a in m.configured_accounts(config)}
                successes = set()
                summary = []
                for row in result.get('accounts', []):
                    domain = accounts[row['index']]['email'].rpartition('@')[2]
                    service = 'outlook' if domain in m.MICROSOFT_DOMAINS else 'naver' if domain == 'naver.com' else 'google'
                    if row['status'] == 'ok':
                        successes.add(service)
                    summary.append({'index': row['index'], 'status': row['status']})
                print(json.dumps({'liveMailboxes': summary, 'successfulServices': sorted(successes),
                                  'asideBinarySHA256': m.hashlib.sha256(pathlib.Path(aside).read_bytes()).hexdigest()}))
                self.assertTrue({'google', 'naver', 'outlook'} <= successes, 'live-service-coverage-incomplete')
            finally:
                after = tabs_now()
                unchanged = all(after.get(key) == value for key, value in before.items())
                no_extra_tabs = set(after) == set(before)
                print(json.dumps({'existingTabsUnchanged': unchanged, 'noOwnedTabsLeft': no_extra_tabs}))
                self.assertTrue(unchanged, 'existing-browser-tabs-changed')
                self.assertTrue(no_extra_tabs, 'collector-tab-cleanup-incomplete')

        def test_live_full_build_and_dashboard_layout(self):
            with tempfile.TemporaryDirectory(prefix='subscription-live-build-') as directory:
                target = pathlib.Path(directory) / 'menubar'
                shutil.copytree(ROOT / 'menubar', target, ignore=shutil.ignore_patterns('.build'))
                build = subprocess.run(['bash', str(target / 'build.sh')], capture_output=True, text=True, timeout=900)
                self.assertEqual(build.returncode, 0, 'full-menu-build-failed')
                binary = target / '.build/cc-menubar'
                qa = subprocess.run([str(binary), '--teamcodex-dashboard-selftest'], capture_output=True, text=True, timeout=30)
                self.assertEqual(qa.returncode, 0, 'full-dashboard-layout-failed')
                print(json.dumps({'fullMenuBuild': 'passed', 'dashboardLayout': 'passed',
                                  'binarySHA256': m.hashlib.sha256(binary.read_bytes()).hexdigest()}))

    def complete_suite():
        sys.path.insert(0, str(ROOT))
        loader = unittest.defaultTestLoader
        return unittest.TestSuite([
            loader.loadTestsFromTestCase(MonitorTests),
            loader.loadTestsFromTestCase(SwiftMonitorTests),
            loader.loadTestsFromName('menubar.Tests.test_account_subscription'),
            loader.loadTestsFromName('menubar.Tests.test_usage_regressions'),
            loader.loadTestsFromTestCase(LiveSurfaceTests),
        ])
    unittest.main(defaultTest='complete_suite', argv=[sys.argv[0]], verbosity=2)
elif __name__ == '__main__':
    unittest.main(verbosity=2)
