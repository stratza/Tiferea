"""Entry point: `python -m tifera`.

Order matters: the in-cluster environment is verified - and the K8s
client configured from in-cluster config - before the app module is imported
or a port is bound. Outside a cluster this exits non-zero within 5 s.
"""

import logging
import threading

import uvicorn


def _log_thread_crash(args: threading.ExceptHookArgs) -> None:
    """Background workers (watch loops, pollers, reapers, PTY pumps) are all
    daemon threads with no supervisor - by default an uncaught exception in
    one just prints to stderr and the thread quietly stops forever. Route it
    through logging instead so it shows up alongside everything else and
    names the thread that died."""
    logging.getLogger("tifera").error(
        "unhandled exception in thread %r - this worker has stopped",
        args.thread.name if args.thread else "?",
        exc_info=(args.exc_type, args.exc_value, args.exc_traceback))


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    threading.excepthook = _log_thread_crash

    from . import config as cfg
    from .incluster import verify_or_die

    verify_or_die()

    # The trust model, stated in one sentence at startup.
    logging.getLogger("tifera").info(
        "TifEra has no console authentication by design: anyone who can reach "
        "the Service holds the full power of this pod's ServiceAccount")

    uvicorn.run("tifera.app:app", host="0.0.0.0", port=cfg.LISTEN_PORT,
                log_config=None)


if __name__ == "__main__":
    main()
