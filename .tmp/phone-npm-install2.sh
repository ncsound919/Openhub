export PATH=/data/data/com.termux/files/usr/bin:$PATH
export HOME=/data/data/com.termux/files/home
cd /data/data/com.termux/files/home/openhub
npm install --save-exact --legacy-peer-deps --ignore-scripts --no-audit --no-fund --no-progress --prefer-offline --fetch-retries 10 --fetch-retry-mintimeout 5000 --fetch-retry-maxtimeout 30000 @deepseek-ai/dsh@0.2.2-alpha.3 @deepseek-ai/dsh-sdk-client@0.2.2-alpha.3 @deepseek-ai/dsh-llm@0.2.2-alpha.3 @deepseek-ai/dsh-sdk-protocol@0.2.2-alpha.3 @deepseek-ai/dsh-scope@0.2.2-alpha.3 @deepseek-ai/dsh-subagent@0.2.2-alpha.3 @deepseek-ai/dsh-commands@0.2.2-alpha.3 > /data/data/com.termux/files/home/dsh-install2.log 2>&1
echo "INSTALL-EXIT=$?" >> /data/data/com.termux/files/home/dsh-install2.log
