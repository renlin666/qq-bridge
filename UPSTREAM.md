# Source and version history

This project is a customized derivative of [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge), originally distributed under the MIT license. Original copyright and license notices remain in `LICENSE`.

The imported local source is based on upstream tag `v0.2.0-r4`, commit `a56164e`. It already contained local integrations before the project-plugin work began. This repository records that imported baseline separately from the plugin-host implementation.

Upstream has subsequent releases. This derivative has not merged upstream `v0.2.1-r1`; its `0.3.0-rc.1` version identifies the local project-plugin API change, not a claim of incorporating every upstream update.

Configure the original repository as a read-only upstream when maintaining this derivative:

```sh
git remote add upstream https://github.com/Derpyu520/qq-bridge.git
git fetch upstream --tags
```

Use feature branches, review changes against the imported baseline, and never force-update published version branches. Keep local configuration, session state, personal assets and third-party local plugins outside Git.

