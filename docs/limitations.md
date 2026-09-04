# Limitations

What this build does not do, stated plainly. Everything here is a real boundary,
not a temporary gap being papered over.

## It is not a compliance tool

It does not check your design against any building regulation, accessibility
standard, fire strategy or planning rule. It applies widely-used conventions and
labels them as conventions. A project can record a `standardsProfile`, and the
assistant will name that standard as the one it is reasoning against — while
saying the model has not been checked against it.

Verifying a design against the standards that apply to it is work for a suitably
qualified person with the current text of those standards.

## Structural figures are indicative

The span-to-depth ratios and slenderness checks are order-of-magnitude sanity
checks for testing whether a massing idea is buildable. They are not design.

## Import is honest, not magic

**IFC** recovers levels, straight extruded walls, spaces and hosted openings as
editable elements. Curved walls, multi-segment walls and walls built from complex
clipping operations fail the shape test and come in as reference geometry —
reported in the import summary, not silently mangled. Materials, property sets
and relationships beyond storey assignment are not converted.

**DXF** converts straight LINE and POLYLINE segments on wall-named layers into
walls at a height and thickness _you_ supply, because a DXF contains neither.
Arcs, splines, hatches, text and block references are reported as unconverted.
Blocks are not exploded.

**glTF, OBJ, STL** carry no architectural semantics and are always reference
geometry. No attempt is made to infer walls from a mesh — that would be exactly
the kind of confident nonsense this product should not produce.

**DWG** is not supported. It is a proprietary binary format with no viable
web-native parser; convert to DXF first.

Reference geometry cannot be edited parametrically. You can trace over it,
measure against it, and delete it.

## Export loses semantics, except in native JSON

Native JSON round-trips exactly — same elements, same ids, same dimensions. GLB,
glTF, OBJ and STL are mesh formats: they carry geometry and, where the format
allows, names and materials. The parametric model does not survive them. IFC
export is not implemented.

## Elements not yet modelled

- **Roof lights and openings in roofs or slabs.** Openings are wall-hosted only.
  The assistant says so rather than substituting something that looks similar.
- **Curved and non-planar walls.** Walls are straight segments; a curve is
  approximated by segments you place.
- **Curtain walling** as a system, with mullions and transoms.
- **Site topography.** The ground is a plane.
- **Furniture beyond the catalogue.** Deliberate: an allowlisted catalogue is
  what makes arbitrary geometry from a model response impossible.

## Vertical moves on some element types

Columns, stairs, railings, rooms and furniture sit on their level and have no
vertical offset parameter, so a Z move on them is reported rather than silently
dropped. Change the element's level, or the level's elevation.

## Polygon offsetting

Roof overhangs use a miter offset, exact for convex outlines and correct for
gentle concavity. Sharp reflex corners are clamped to a 4× miter limit rather
than shooting off to infinity. Self-intersections at large offsets are not
resolved — that would need a full straight-skeleton implementation, which is not
worth the maintenance burden for offsets capped at 5 m.

## Collaboration

Single-user per project. A second tab editing the same project gets a clear
conflict rather than a silent overwrite, but there is no live multiplayer
editing, no presence and no commenting.

## Scale

Capped at 5,000 elements per project, 400 per AI turn, 300 commands per
transaction, 50 MB per upload and 5 MB per knowledge document. Beyond those, the
viewport stops being interactive and the caps are there to say so before it
happens rather than after.

## Retrieval quality

The default embedder is lexical, not neural. It will not connect "daylight
factor" to "natural illumination". See
[decisions.md](decisions.md#a-lexical-embedder-by-default) for the seam to swap
it.

## The local interpreter

Without an API key, the assistant matches patterns — it does not reason. It
covers the documented modelling operations well and says so plainly when a
request falls outside them. It is not a substitute for a model on open-ended
design conversation, and it does not pretend to be.
