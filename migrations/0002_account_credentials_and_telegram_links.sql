ALTER TABLE accounts ADD COLUMN x_client_id TEXT;
ALTER TABLE accounts ADD COLUMN x_client_secret TEXT;

UPDATE accounts
SET x_client_id = COALESCE(
      x_client_id,
      (SELECT users.x_client_id FROM users WHERE users.telegram_chat_id = accounts.telegram_chat_id)
    ),
    x_client_secret = COALESCE(
      x_client_secret,
      (SELECT users.x_client_secret FROM users WHERE users.telegram_chat_id = accounts.telegram_chat_id)
    )
WHERE x_client_id IS NULL
   OR x_client_secret IS NULL;

ALTER TABLE media ADD COLUMN telegram_file_path TEXT;
ALTER TABLE media ADD COLUMN telegram_file_url TEXT;
