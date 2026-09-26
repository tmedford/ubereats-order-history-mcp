# Code standards — write less, not more

The governing principle: **every change should leave the codebase smaller or the
same size for the same capability.** When you add code that replaces something,
delete the thing it replaces in the *same* change. Spurious code — a new path
bolted on beside the old one, a helper nobody else calls, a defensive check the
schema already guarantees — is a defect, not a neutral.

Rules are numbered so reviews can cite "CS-4" etc.

---

## CS-1 — One function with parameters, not many near-duplicates

When you need the same work under different conditions, write **one** function
with a combined/parameterized signature. Never copy an existing function and
tack on another `if` to produce a near-duplicate. If two functions differ only
by a filter, a flag, or a column list, they are one function with a parameter.

## CS-2 — One fetch + one loop, not two parallel branches

When two `if`/`elif` branches both run the same load and walk the same collection,
that's **one load + one loop with conditional extras inside** — not two duplicated
blocks. Compute boolean flags up top (`needs_x = …`), do the fetch and the loop
once, and gate the per-branch extras with `if needs_x:` inside. Check the
dominant flag first to preserve precedence. Duplicated fetch+loop pairs drift —
one branch gets a fix, the other doesn't.

## CS-3 — One generic writer, not per-field setters

Persist changes through a single keyed/parameterized writer. Do not add
`set_status()`, `set_label()`, `set_flag_x()` siblings when one
`update(id, **fields)` would do. Extend the one writer; never add a new
per-field method beside it.

## CS-4 — Reference `model.x` directly — no aliases

Reference `self.x` / `model.x` / `row['col']` at the point of use. Never
introduce `x = model.x` just to shorten a reference — it hides where state
lives and adds a line that explains nothing. Bind a local only when the value
is genuinely reused after an expensive computation or a real cross-call.

## CS-5 — Imports at the top of the file, always

No imports inside functions, methods, or handlers. A function-local import is a
structural smell; fix the module structure instead. All imports live at the top
of the file.

## CS-6 — One fetch surface, one return shape

A reader gets **one** function returning a collection; callers index `[0]` when
the query guarantees a result or handle the empty case explicitly. Don't pair a
list function with a `fetch_by_id()` sibling when it's the same query — that's
a second public surface the caller must remember. A dedicated single-item
function is justified only when it genuinely differs (different index, paging,
authorization).

## CS-7 — One data shape per concept

Expose one model/dict shape that carries what every caller reads. Don't return
both a summary and the raw list of the same data — pick one. Two shapes for one
concept drift the same way two functions do.

## CS-8 — One async surface — no blocking sibling

Expose **only** async methods. Don't add a sync wrapper (`asyncio.run(...)`) for
one specific caller — keep the surface async-only and make the caller live in
the event loop. (A sync variant is allowed only where being sync is
load-bearing, e.g. a one-shot CLI script.)

## CS-9 — Single-use bindings and helpers don't earn a name

If a constant, variable, or private helper is referenced exactly once, inline
it at the call site — when that's behavior-preserving: trivial, side-effect-free,
and inlining doesn't change when it runs. A name earns its line when at least
two callers share it, when it guards evaluation, or when extracting genuinely
tames a long caller.

## CS-10 — Trust the schema and the types — no defensive coercion

When a value comes from a typed source you control — a DB column, a parsed
model, a structured config — read it directly. No `.get(key, default)` on a
key that's always present; no redundant `float()`/`int()` casts on typed
values. Boundary conversion belongs only at system edges: external HTTP/WS
payloads, user CLI input, untyped JSON from third parties.

## CS-11 — Fail hard; await every coroutine

No catch-and-swallow `except Exception` blocks — let real exceptions propagate
with the original type and traceback. Every coroutine is awaited. When you make
a function async, grep every call site and fix each one. Verification: run a
real code path through the changed surface; static checks alone are not
sufficient.

---

## The meta-rule: delete-as-you-add

Before opening a PR, for each thing you added, name the thing it replaced — and
confirm that thing is gone in the same diff. If nothing was replaced, the
addition is genuinely new; say so. If something *was* replaced but the old path
is still in the tree, the PR isn't done.
