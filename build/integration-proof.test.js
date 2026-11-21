'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {passedInbound,classify,sanitize}=require('./integration-proof');

test('live MCP proof requires both successful tools, the requested file and a fresh returned nonce',()=>{
  const calls=[{tool:'workspace_info',ok:true},{tool:'read_file',args:{path:'proof.txt'},ok:true}];
  assert.equal(passedInbound(calls,'new-nonce','new-nonce','proof.txt'),true);
  assert.equal(passedInbound(calls,'stale-nonce','new-nonce','proof.txt'),false);
  assert.equal(passedInbound(calls.slice(1),'new-nonce','new-nonce','proof.txt'),false);
  assert.equal(passedInbound(calls,'new-nonce','new-nonce','other.txt'),false);
  assert.equal(passedInbound([{...calls[0],ok:false},calls[1]],'new-nonce','new-nonce','proof.txt'),false);
  assert.equal(passedInbound([],'I called both tools: new-nonce','new-nonce','proof.txt'),false);
});
test('evidence redaction processes raw nested strings before JSON serialization',()=>{
  const value=sanitize({stdout:'{"access_token":"private-access-value"}',calls:[{text:'Bearer private-value'}]});
  assert.ok(!JSON.stringify(value).includes('private-'));
  assert.match(value.stdout,/REDACTED/);
});
test('account, timeout and integration failures are reported separately',()=>{
  assert.equal(classify('401 Unauthorized: missing bearer'),'hesap/kota');
  assert.equal(classify('Free usage limit reached'),'hesap/kota');
  assert.equal(classify('request aborted'),'zaman aşımı');
  assert.equal(classify('prompt was read as value of --tools'),'çalıştırma/protokol');
  assert.equal(classify('Unexpected server error'),'çalıştırma/protokol');
});
