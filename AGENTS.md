# Pi Accounts Guidelines

## Storage and concurrency

- Pass one stable plain Node `fs` adapter to async and sync `proper-lockfile` calls because Bun can reject annotations on loader-proxied `graceful-fs`.
- Represent credential maps as own-property dictionaries so names such as `__proto__` and `constructor` cannot reach `Object.prototype`.
- On every locked credential read, reject symlinks, validate path identity and permissions, and repair `0600` through the open descriptor.
- Exclude canonical, legacy, temporary, and recovery credential names from sync and export.
- Invalidate in-flight OAuth or account work during cleanup instead of waiting behind a serialized conversion.
- Guard credential mutation and outer status or connection publication with latest-task ownership.

## Provider overlays

- Preserve the complete previous provider configuration when applying a runtime overlay.
- Verify the resolved key rather than the reported authentication source, and fail closed when stored authentication cannot be displaced.
