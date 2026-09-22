const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createWorkspaceProvider, createMemoryWorkspaceStore, credentialCipher, hash } = require('./workspace.cjs');

test('encrypted credentials authenticate ciphertext and do not expose the token', () => {
  const cipher = credentialCipher('a'.repeat(32)), sealed = cipher.seal({ token: 'secret' });
  assert.deepEqual(cipher.open(sealed), { token: 'secret' });
  assert(!sealed.includes('secret'));
  assert.throws(() => credentialCipher('b'.repeat(32)).open(sealed));
});

test('connection binds accounts, rejects mismatches and replay, and revokes API access', async () => {
  const app = express(), store = createMemoryWorkspaceStore();
  app.use((req, _res, next) => { req.session = req.headers['x-test-user'] ? { userId: req.headers['x-test-user'] } : {}; next(); });
  app.use(createWorkspaceProvider({ appId: 'test', sourceOrigin: 'https://library.test', store, getUser: async id => ({ id }) }));
  app.get('/api/data', (req,res)=>res.json({ userId:req.session.userId }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  try {
    const verifier='v'.repeat(43), state='s'.repeat(43), redirectUri='https://library.test/workspace/connected';
    const request={challenge:hash(verifier),state,redirectUri,sourceOwner:'library-user'};
    assert.equal((await post('/api/workspace/authorize',request)).status,401);
    assert.equal((await post('/api/workspace/authorize',{...request,redirectUri:'https://evil.test'},{'x-test-user':'app-user'})).status,400);
    const code=await (await post('/api/workspace/authorize',request,{'x-test-user':'app-user'})).json();
    assert.equal((await post('/api/workspace/exchange',{...code,verifier:'wrong'})).status,401);
    const result=await post('/api/workspace/exchange',{...code,verifier});
    assert.equal(result.status,200);
    const grant=await result.json();
    assert.equal(grant.userId,'app-user');assert.equal(grant.sourceOwner,'library-user');
    assert.equal((await post('/api/workspace/exchange',{...code,verifier})).status,401);
    const headers={authorization:'Bearer '+grant.token};
    assert.equal((await (await fetch(base+'/api/data',{headers})).json()).userId,'app-user');
    assert.equal((await post('/api/auth/logout',{},headers)).status,403);
    await post('/api/workspace/revoke',{},headers);
    assert.equal((await fetch(base+'/api/data',{headers})).status,401);
    await store.put('expired',{userId:'old'},Date.now()-1);
    assert.equal(await store.consume('expired'),null);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('streaming delegated responses preserve the standalone session', async()=>{
 const session=require('express-session'),app=express(),store=createMemoryWorkspaceStore();
 app.use(session({secret:'synthetic-session-secret-for-test',resave:false,saveUninitialized:false}));
 app.post('/login',(req,res)=>{req.session.userId='standalone-user';res.json({ok:true});});
 app.use(createWorkspaceProvider({appId:'test',sourceOrigin:'https://library.test',store,getUser:async id=>({id})}));
 app.get('/api/stream',(req,res)=>{res.type('text');res.write(req.session.userId);res.end(':complete');});
 const token='t'.repeat(43);await store.put('grant:'+hash(token),{appId:'test',userId:'connected-user',sourceOwner:'source-user'},Date.now()+60000);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const url='http://127.0.0.1:'+server.address().port;
 try{
  const login=await fetch(url+'/login',{method:'POST'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const delegated=await fetch(url+'/api/stream',{headers:{cookie,authorization:'Bearer '+token}});
  assert.equal(await delegated.text(),'connected-user:complete');assert.equal(delegated.headers.get('set-cookie'),null);
  assert.equal(await (await fetch(url+'/api/stream',{headers:{cookie}})).text(),'standalone-user:complete');
 }finally{await new Promise(resolve=>server.close(resolve));}
});
