# Security Policy

Blackwell DB includes optional secure collections for encrypting private user payloads before local storage.

## Reporting a Vulnerability

Open a private security advisory on GitHub if available, or contact the repository owner directly.

## Security Boundary

- Secure collections encrypt private payloads with AES-GCM.
- Company/admin views expose operational metadata only.
- Any process holding the encryption key can decrypt private data.
- Key storage, key recovery, and sync trust models belong to the application using Blackwell DB.
