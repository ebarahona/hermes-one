// The component-boundary contract every platform component declares, transcribed VERBATIM from
// loopback/component-registry.md (050 §6). A boot test cross-checks that the keys a component
// claims to bind are actually bound and belong to its plane.

/** The declaration every platform component satisfies (050 §6). @public */
export interface PlatformComponentBoundary {
  readonly plane: 'edge' | 'agent';
  /** binding keys this component binds (from binding-key-registry.md) */
  readonly bindsKeys: readonly string[];
  /** extension-point ids this component implements (contributes extensions to) */
  readonly implementsExtensionPoints: readonly string[];
  /** extension-point ids this component consumes (reads extensions from) */
  readonly consumesExtensionPoints: readonly string[];
  /** discovery tags this component contributes (from binding-tag-registry.md) */
  readonly contributesTags: readonly string[];
  /** JSON Schema $id for this component's config, if any */
  readonly configSchemaId?: string;
}
