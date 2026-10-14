-- Match the reconciler's JSON path filter and scan only call requests.
CREATE INDEX CONCURRENTLY "messages_call_recovery_idx" ON "messages"
((blocks #> ARRAY['0', 'status']), "createdAt")
WHERE role = 'bot' AND "clientNonce" LIKE 'call:%' AND "clientNonce" LIKE '%:request';
