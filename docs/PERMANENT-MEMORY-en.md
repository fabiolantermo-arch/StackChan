# Robottino's permanent memory

A dedicated SQLite store, RobotMemory, binding ROBOT_MEMORY, in the same Worker robottino-stackchan but separate from the ChatSession history. No binding, database ID or credential of other projects. A single owner tied to the Robottino token; owner IDs cannot be chosen by the client.

Authenticated API: GET /api/memories lists the memories; POST /api/memories takes a JSON command.

Actions: remember (text, kind profile/fact/preference, optional expiresAt in milliseconds), update (id, text), forget (id), forget_match (text: deletes only if exactly one memory matches, otherwise `ambiguous`/`not_found`), recall (query; without a query it returns up to 12 memories of every kind, profiles first), list, prepare_clear and clear (with the confirmation returned by prepare_clear). The confirmation is valid for 2 minutes, once only, and is invalidated by new saves. No total deletion without this confirmation.

At most 100 memories, 500 characters each. Provenance explicit_user_command, with creation and update dates. Expiry is applied on reading. The filters reject common credentials but cannot promise to recognise every possible secret: never store passwords or keys. No audio in the memory store. The platform's recovery copies are not removed by the logical deletion.

On the WebSocket send {"type":"memory.command","command":{"action":"remember","text":"Mi piace il mare"}} or {"type":"memory.command","text":"Ricorda che mi piace il mare"}. The answer is memory.result. Commands are not forwarded to the provider as instructions. Profile memories are available when either mode opens; recall retrieves the other information when relevant. Without the memory, the voice goes on.

For Live 1 fragments of transcript are not saved automatically: the client must send the command once it has the complete sentence. Natural commands that correct or delete a single memory will be resolved by the app choosing the exact ID; the backend does not delete memories by similarity. The memory.result answers must be shown or played by the client.

Deleting the permanent memories does not delete the recent history already in the sessions, nor contexts already sent to the providers. End the session and start again with a new sessionId so that earlier contexts are not reused. A single way of deleting across all sessions is still to be completed.


Spoken phrases recognised (in Italian): «Ricorda che…», «Dimentica che…», «Cosa ricordi/sai di me?», «Cosa ricordi di/del/della…?», «Dimentica tutto» (with a confirmation on the iPhone's screen).
