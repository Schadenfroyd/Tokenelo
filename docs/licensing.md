# Release and licensing status

The tracker source in this repository is released under the [Apache License 2.0](../LICENSE), and [NOTICE](../NOTICE) names the copyright holder. As of October 31, 2026 this covers the source files, tests, build scripts, original documentation and synthetic examples published here. It does not cover any future installers, signed builds or hosted services, which are not published and would carry their own terms.

The price tables in `rates/` record third-party vendor list prices and their sources; the [support matrix](support-matrix.md) describes the review caveat for that data. The tree also includes one prebuilt Windows helper executable in `native/`, with a manifest recording its source, binary and compiler hashes; the build checks its exact bytes and copies it without running it.

Third-party packages keep their own licenses. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) is a checklist of what remains to be done for notices, and the [generated inventory and candidate notices](third-party/README.md) cover the development dependency tree. The tracker has no production dependencies, and none of those packages is bundled into the compiled product today. The inventory check flags one development-only package whose license it classes as unknown.

Apache 2.0 permits companies, vendors, and developers to use, modify and redistribute the source, including commercial reuse and forks, under its terms. Product names and endorsement rights are handled separately; see [trademarks](trademarks.md).

Publishing source does not make Tokenelo a supported release. See the [release status](status.md) for what remains open; the [quick start](quick-start.md) and [support matrix](support-matrix.md) are release drafts. [GitHub's explanation of licensing](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
