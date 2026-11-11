import {afterEach,expect,it,vi} from 'vitest';
import {env,runInDurableObject} from 'cloudflare:test';

afterEach(()=>vi.restoreAllMocks());
// The provider is a fake socket pair per call: the test keeps the provider's end to see when a call is closed.
function fakeProvider(){
  const ends:WebSocket[]=[];
  vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{
    if(String(input).includes('get-signed-url'))return Response.json({signed_url:'wss://api.elevenlabs.io/test'});
    const pair=new WebSocketPair();pair[1].accept();ends.push(pair[1]);
    return new Response(null,{status:101,webSocket:pair[0]});
  });
  return ends;
}
const call=(query:string)=>new Request('https://test/api/voice?provider=elevenlabs'+query,{headers:{Upgrade:'websocket'}});
const closed=(ws:WebSocket)=>new Promise<void>(resolve=>ws.addEventListener('close',()=>resolve()));

it('a new call from the robot replaces the one left open by a restart; any other second call is still busy (owner, 11 Nov 2026)',async()=>{
  const stub=env.CHAT_SESSIONS.getByName('stream:elevenlabs:robot-test');
  await runInDurableObject(stub,async(session:any)=>{
    const ends=fakeProvider();
    const first=await session.fetch(call('&sessionId=robot'));expect(first.status).toBe(101);first.webSocket.accept();
    // The robot restarted: its old connection says nothing. A new call arrives.
    const gone=closed(ends[0]);
    const second=await session.fetch(call('&sessionId=robot'));expect(second.status).toBe(101);second.webSocket.accept();
    await gone;expect(ends).toHaveLength(2);
    // A second call that is not the robot's is refused as before.
    const other=await session.fetch(call(''));expect(other.status).toBe(409);
    second.webSocket.close();
  });
});
