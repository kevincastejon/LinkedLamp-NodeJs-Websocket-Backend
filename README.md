# LinkedLamp Backend (Node.js)

This backend provides:
- A REST API for user accounts (username/password) and LinkedGroups management
- A WebSocket server for ESP32 devices to join a group (by **stable groupId**) and exchange hue updates

The backend uses a simple JSON file database (`db.json`) for persistence.

## Requirements
- Node.js 18+ recommended

## Install
```bash
npm install
```

## Run
```bash
node index.js
```

The server listens on port **3000**.

## Environment variables

### `DB_PATH` (optional)
Path to the JSON database file.

- Default: `./db.json` (next to `index.js`)
- Example:

Linux/macOS:
```bash
export DB_PATH="/var/lib/linkedlamp/db.json"
```

Windows (PowerShell):
```powershell
$env:DB_PATH="C:\linkedlamp\db.json"
```

### `TOKEN_ENC_KEY_B64` (optional but recommended)
A **32-byte** secret key (Base64 encoded) used to encrypt the stored user token at rest (in `db.json`).

If not set, the backend stores the token unencrypted in the JSON DB file.

Generate a random 32-byte key:

Linux/macOS:
```bash
python3 - << 'PY'
import os, base64
print(base64.b64encode(os.urandom(32)).decode())
PY
```

Windows (PowerShell):
```powershell
python - << 'PY'
import os, base64
print(base64.b64encode(os.urandom(32)).decode())
PY
```

Set it:
```bash
export TOKEN_ENC_KEY_B64="YOUR_BASE64_32B_KEY"
node index.js
```

Windows (PowerShell):
```powershell
$env:TOKEN_ENC_KEY_B64="YOUR_BASE64_32B_KEY"
node index.js
```

### `SMTP` (for users password reset)
Variables configuring SMTP (Google). (https://myaccount.google.com/apppasswords)

Linux/macOS:
```bash
export SMTP_HOST="smtp.gmail.com"
export SMTP_PORT="587"
export SMTP_SECURE="false"
export SMTP_USER="your_google_account_name@gmail.com"
export SMTP_PASS="your_google_app_password"
export SMTP_FROM="YourGoogleAccountName <your_google_account_name@gmail.com>"
```

Windows (PowerShell):
```powershell
$env:SMTP_HOST="smtp.gmail.com"
$env:SMTP_PORT="587"
$env:SMTP_SECURE="false"
$env:SMTP_USER="your_google_account_name@gmail.com"
$env:SMTP_PASS="your_google_app_password"
$env:SMTP_FROM="YourGoogleAccountName <your_google_account_name@gmail.com>"
```

## Data model (JSON DB)

The JSON file contains:
- `users`: user accounts with password hash and a stable token (stored encrypted if `TOKEN_ENC_KEY_B64` is set)
- `groups`: LinkedGroups identified by immutable `id` (UUID) and editable `name`
- `groupMembers`: membership table with `role` (`owner` or `member`)

A default group is automatically created for each user:
- `isDefault: true`
- `name: "<username>LinkedGroup"`
- It cannot be renamed or deleted by the REST API rules.

## REST API (summary)

### Register
`POST /register`

Body:
```json
{ "username": "alice", "password": "secret", "email": "alice@example.com" }
```

- `email` is optional and not verified.
- Response:
```json
{ "token": "..." }
```

### Login
`POST /login`

Body:
```json
{ "username": "alice", "password": "secret" }
```

Response:
```json
{ "token": "..." }
```

Important: login returns the **same stable token** created at registration (so already-provisioned devices keep working).

### Authenticated requests
Send:
`Authorization: Bearer <token>`

### List groups (for the MAUI Picker)
`GET /groups`

Response:
```json
{
  "groups": [
    {
      "id": "uuid",
      "name": "Salon",
      "ownerUserId": "uuid",
      "isDefault": false,
      "role": "owner",
      "canLeave": false,
      "canRename": true,
      "canDelete": true,
      "canManageMembers": true
    }
  ]
}
```

### Create group
`POST /groups`

Body:
```json
{ "name": "MyGroup" }
```

### Rename group (owner only, not default)
`PATCH /groups/{groupId}`

Body:
```json
{ "name": "NewName" }
```

### Delete group (owner only, not default)
`DELETE /groups/{groupId}`

### Add member (owner only)
`POST /groups/{groupId}/members`

Body:
```json
{ "username": "bob" }
```

The target user must already exist.

### Leave group (member only; owner cannot leave)
`POST /groups/{groupId}/leave`

## WebSocket protocol (ESP32)

### Connect
Connect to:
- `ws://<host>:3000` (development)
- Prefer `wss://` behind a TLS reverse-proxy in production

### First message (required)
Immediately after the WS connection opens, the client must send:
```json
{ "type": "auth", "token": "<userToken>", "groupId": "<groupId>" }
```

Server will:
- validate the token
- validate that the group exists
- validate that the user is a member of the group

If OK, server replies:
```json
{ "type": "ok", "hue": 0 }
```

### Hue changes
Client can send:
- `"+"` to increment
- `"-"` to decrement

Server broadcasts to all clients in the same group:
```json
{ "type": "hue", "hue": 123 }
```

## Notes
- Group names can change at any time; ESP32 must always use `groupId`.
- If a group is deleted or a user leaves the group, devices using that `groupId` will no longer be authorized to join it.
