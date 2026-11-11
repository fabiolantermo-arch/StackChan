export async function memoryAPI(request:Request,env:Env){
  const store=env.ROBOT_MEMORY.getByName('owner');
  if(request.method==='GET')return Response.json({memories:await store.list()},{headers:{'cache-control':'no-store'}});
  if(request.method!=='POST')return Response.json({error:'method_not_allowed'},{status:405});
  if(!request.headers.get('content-type')?.includes('application/json'))return Response.json({error:'unsupported_media_type'},{status:415});
  const reader=request.body?.getReader();if(!reader)return Response.json({error:'invalid_body'},{status:400});
  let size=0,raw='';const decoder=new TextDecoder();
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();return Response.json({error:'payload_too_large'},{status:413});}raw+=decoder.decode(value,{stream:true});}
  try{const result=await store.command(JSON.parse(raw+decoder.decode()));return Response.json(result,{status:'error'in result?400:200,headers:{'cache-control':'no-store'}});}catch{return Response.json({error:'memory_unavailable'},{status:503});}
}
