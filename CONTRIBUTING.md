# Contributing

Thanks for helping improve Blackwell DB.

## Local Setup

```bash
npm install
npm test
```

## Development Notes

- Keep the database embedded and local-first.
- Do not add backend-server requirements to the core engine.
- Keep private payloads encrypted when using secure collections.
- Add focused tests for storage, query, encryption, and control-plane behavior.

## Pull Requests

Before opening a pull request, run:

```bash
npm test
npm run bench -- 20000
```
