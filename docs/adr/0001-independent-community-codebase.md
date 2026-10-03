# 0001: Independent community codebase

Status: accepted

## Context

Small self-hosted teams need private user spaces, a usable default model and
simple account management. Feedback should be able to change this product's
scope and pace without requiring synchronized changes in another application.

## Decision

Maintain dsh-phalanx as an independently evolving community repository. Keep its
own source history, release inputs, tests and documented supported interfaces.
Do not make an automatically synchronized shared core or a feature-flag product
matrix a prerequisite for community changes. Integrate external DSH through its
official interfaces at a pinned revision, with one owner per seam.

## Alternatives and consequences

A shared core would reduce duplicate maintenance but couple interface and
release decisions. A feature matrix would expand the combinations contributors
must understand and test. Independent evolution keeps the public design small;
reuse or upstream changes are deliberate, reviewed changes with their own tests.
Source drift and manual integration effort are accepted costs. This decision
provides no migration promise for unrelated products or historical databases.
