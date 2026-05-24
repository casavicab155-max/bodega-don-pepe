import json
import urllib.request
from http.server import SimpleHTTPRequestHandler, HTTPServer

CLAUDE_API_KEY = ""

class ProxyHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        if self.path == '/chat':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            
            try:
                data = json.loads(post_data.decode('utf-8'))
                prompt = data.get('prompt', '')
                
                req_body = {
                    "model": "claude-haiku-4-5-20251001",
                    "max_tokens": 1024,
                    "messages": [
                        {"role": "user", "content": prompt}
                    ]
                }
                
                req = urllib.request.Request("https://api.anthropic.com/v1/messages", method="POST")
                req.add_header("x-api-key", CLAUDE_API_KEY)
                req.add_header("anthropic-version", "2023-06-01")
                req.add_header("content-type", "application/json")
                
                with urllib.request.urlopen(req, data=json.dumps(req_body).encode('utf-8')) as response:
                    anthropic_response = json.loads(response.read().decode('utf-8'))
                    reply_text = anthropic_response['content'][0]['text']
                    
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"text": reply_text}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                print("Error:", e)
                if hasattr(e, 'read'):
                    err_body = e.read().decode('utf-8')
                    print("Anthropic API Error:", err_body)
                    self.wfile.write(json.dumps({"error": str(e) + " - " + err_body}).encode('utf-8'))
                else:
                    self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
        else:
            self.send_error(404)

if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', 3001), ProxyHandler)
    print("Serving on port 3001...")
    server.serve_forever()
