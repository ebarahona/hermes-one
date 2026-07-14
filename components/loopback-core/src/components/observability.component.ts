// ObservabilityComponent (edge): binds the telemetry ports (loopback/component-registry.md).
// The dev/stdout implementations from @platform-internal/telemetry today; the OTel SDK swap (tracer +
// real exporter) is OB5 — TRACER is deliberately not bound until it exists (flagged in bindings.ts).
import {Binding, type Component} from '@loopback/core';
import {BindingScope} from '@loopback/context';
import {JsonLogger, LoggingMeter} from '@platform-internal/telemetry';
import type {Logger} from '@platform/contracts';
import {PlatformBindings} from '../bindings.js';
import type {PlatformComponentBoundary} from '../boundary.js';

export class ObservabilityComponent implements Component, PlatformComponentBoundary {
  readonly plane = 'edge' as const;
  readonly bindsKeys = [PlatformBindings.LOGGER.key, PlatformBindings.METER.key];
  readonly implementsExtensionPoints: readonly string[] = [];
  readonly consumesExtensionPoints: readonly string[] = [];
  readonly contributesTags: readonly string[] = [];

  bindings: Binding[] = [
    Binding.bind(PlatformBindings.LOGGER.key)
      .toDynamicValue(() => new JsonLogger('info'))
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.METER.key)
      .toDynamicValue(({context}) => new LoggingMeter(context.getSync<Logger>(PlatformBindings.LOGGER.key)))
      .inScope(BindingScope.SINGLETON),
  ];
}
