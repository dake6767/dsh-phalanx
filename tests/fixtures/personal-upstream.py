"""Fictional Anthropic/Tavily upstream for isolated Linux network acceptance.

No forwarding, real credentials, request-body logging or persistent state.
Run in the test network namespace, never as a production service.
"""
import argparse, json, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
COUNTS={'model':0,'search':0};LOCK=threading.Lock();MARKER='PUBLIC_TAVILY_FIXTURE_OK'
args=argparse.ArgumentParser();args.add_argument('--host',required=True);args.add_argument('--port',type=int,default=18443);options=args.parse_args()
def text_events(text):
 return [{'type':'message_start','message':{'usage':{'input_tokens':3,'output_tokens':0}}},{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}},{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':text}},{'type':'content_block_stop','index':0},{'type':'message_delta','delta':{'stop_reason':'end_turn'},'usage':{'output_tokens':20}},{'type':'message_stop'}]
def tool_events(name, data):
 e=text_events('');e[1]['content_block']={'type':'tool_use','id':'spike-web-search','name':name,'input':{}};e[2]['delta']={'type':'input_json_delta','partial_json':json.dumps(data)};e[4]['delta']['stop_reason']='tool_use';return e
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def send(self,code,body,kind='application/json'):
  data=body.encode();self.send_response(code);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def do_GET(self):
  if self.path=='/fixture/health':self.send(200,json.dumps(COUNTS))
  else:self.send(404,'{}')
 def do_POST(self):
  if not self.path.startswith('/fixture/'):self.send(404,'{}');return
  try:
   size=int(self.headers.get('Content-Length','0'));assert 0<size<=2*1024*1024
   body=json.loads(self.rfile.read(size));assert isinstance(body,dict)
  except Exception:self.send(400,'{}');return
  if self.path.rstrip('/').endswith('/search'):
   if body.get('api_key')!='tvly-fixture-key' and self.headers.get('Authorization')!='Bearer tvly-fixture-key':self.send(403,'{}');return
   with LOCK:COUNTS['search']+=1
   self.send(200,json.dumps({'query':body.get('query',''),'results':[{'title':MARKER,'url':'https://example.test/fixture','content':MARKER,'score':1}],'answer':MARKER,'response_time':0.001}));return
  if not self.path.rstrip('/').endswith('/messages'):self.send(404,'{}');return
  if self.headers.get('x-api-key')!='personal-fixture-key' and self.headers.get('Authorization')!='Bearer personal-fixture-key':self.send(403,'{}');return
  with LOCK:COUNTS['model']+=1
  texts=[];results=[]
  for message in body.get('messages',[]):
   if message.get('role')!='user':continue
   content=message.get('content',[])
   if isinstance(content,str):content=[{'type':'text','text':content}]
   for block in content:
    if block.get('type')=='tool_result' and block.get('tool_use_id')=='spike-web-search':results.append(block)
    if block.get('type')=='text':
     text=block.get('text','')
     if not text.startswith(('Current runtime context','Time sampled while preparing turn ','<system-reminder>')):texts.append(text)
  prompt=texts[-1] if texts else ''
  events=text_events('PERSONAL_MODEL_READY')
  if prompt.startswith('Generate the session title'):events=text_events('Personal fixture')
  elif 'PLUGIN_NETWORK_TASK' in prompt:
   if results:events=text_events('PLUGIN_NETWORK_CONFIRMED' if any(not r.get('is_error') and MARKER in json.dumps(r) for r in results) else 'PLUGIN_NETWORK_FAILED')
   else:
    tool=next((t for t in body.get('tools',[]) if t.get('name')=='web_search'),None)
    if not tool:events=text_events('PLUGIN_NETWORK_FAILED')
    else:
     schema=tool.get('input_schema',{})
     data={}
     for key, prop in schema.get('properties',{}).items():
      if key not in schema.get('required',[]) and key not in ('query','queries'):continue
      data[key]=['fixture query'] if prop.get('type')=='array' else (1 if prop.get('type') in ('number','integer') else 'fixture query')
     events=tool_events('web_search',data)
  self.send(200,''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events),'text/event-stream')
server=ThreadingHTTPServer((options.host,options.port),Handler)
timer=threading.Timer(7200,server.shutdown);timer.daemon=True;timer.start()
server.serve_forever()
