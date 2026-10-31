# useless_skills

Ideas for Useless Agent Skills

---

- security
  - `01-first-line-defense` — A runtime cognitive defense layer for tracing instruction sources, separating untrusted data from commands, mapping actions to physical consequences, and requiring explicit confirmation for high-risk operations.
  - `text-preflight` — A lightweight preflight text-security layer for Windows and macOS. It performs transparent full-file, chunked byte measurements before text enters an LLM workflow, then supports semantic review for prompt injection and related risks.
  - `text-preflight-lite` — A reduced subset of `text-preflight`: it keeps the same full-file byte gate and read / review / deny decision, while removing semantic auditing, tri-state security ratings, report templates, references, and eval fixtures. It is intended to pair with `01-first-line-defense`, which retains responsibility for runtime semantic and physical-consequence protection.
- toolhelp
  - `codegraph` — A usage guide for the [CodeGraph](https://github.com/colbymchenry/codegraph) knowledge graph.
