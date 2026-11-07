export PATH=/data/data/com.termux/files/usr/bin:$PATH
echo "--- tcp test to 1.1.1.1:80"
curl -s -m 12 -o /dev/null -w "code=%{http_code}\n" http://1.1.1.1/
echo "curl-exit=$?"
echo "--- tcp test to laptop-tether-check 192.168.1.253:4873"
curl -s -m 10 -o /dev/null -w "code=%{http_code}\n" http://192.168.1.253:4873/
echo "curl-exit=$?"
echo "--- reverse localhost:4873"
curl -s -m 10 -o /dev/null -w "code=%{http_code}\n" http://127.0.0.1:4873/
echo "curl-exit=$?"
