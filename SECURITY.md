# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it by emailing:

**rob@superiortech.io**

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive a response within 48 hours acknowledging receipt. Security issues will be prioritized and addressed as quickly as possible.

## Security Considerations

This MCP server:
- Runs locally on your machine
- Uses the `osxphotos` Python library to read the macOS Photos library; it is read-only except for the `export` tool, which writes copies of photos to a directory you specify (never into the library)
- Does not transmit data to external servers
- Does not store credentials or passwords

Reading the Photos library requires the host process to be granted **Full Disk Access** by macOS. This permission is managed by macOS and can be revoked at any time in System Settings → Privacy & Security → Full Disk Access. Run the `doctor` tool to diagnose permission issues.
