import urllib.request
import json

url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyBU1hM7iZo0iZ56MSZMHmunz_gcfXKd_9A"
req = urllib.request.Request(url, method="POST")
req.add_header("Content-Type", "application/json")
data = json.dumps({"contents": [{"parts": [{"text": "Hola"}]}]}).encode("utf-8")

try:
    with urllib.request.urlopen(req, data=data) as response:
        print("SUCCESS")
        print(response.read().decode())
except urllib.error.HTTPError as e:
    print(f"HTTP ERROR: {e.code}")
    print("BODY:", e.read().decode())
except Exception as e:
    print("OTHER ERROR:", e)
