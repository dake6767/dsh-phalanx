Envelopes written with a throwaway fixture master key, one per protected table the
stores declare. They were generated at source b2a0980, whose key owner
(`adapters/platform-secrets.ts`, `domain/platform-secret.ts`) differs from the
previous release only in formatting; a cross-check decrypted these envelopes with
that release's code and each side read the other's ciphertext for every table.
Record and field values are representative, not each store's exact composition.
A test decrypts every entry with the current code and requires the exact
plaintext, so a codec change cannot silently orphan ciphertext deployed databases
already hold. Never regenerate these files.
