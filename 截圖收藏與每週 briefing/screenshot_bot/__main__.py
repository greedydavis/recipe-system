import sys

from .config import ConfigError


def run() -> None:
    from telegram.error import InvalidToken

    from .bot import main

    try:
        main()
    except ConfigError as exc:
        print(f"設定錯誤：{exc}\n請參考 .env.example 與 README。", file=sys.stderr)
        sys.exit(2)
    except InvalidToken:
        print("TELEGRAM_BOT_TOKEN 無效，請到 @BotFather 確認 token 是否正確。", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    run()
