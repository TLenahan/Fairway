# FLIGHT_MODEL — spec for `libs/flight-model` (`@golf/flight-model`)

Authoritative build spec for the ball-flight physics engine. **This is the one module where a fudge-factor shortcut silently corrupts every distance in the app.** Implement the real projectile model below, source the aerodynamic coefficients from a **cited** dataset, and validate against the sanity targets in §7. Output must satisfy `FlightResultSchema` (CONTRACTS.md).

The device sends **kinematics only** — it never transmits carry/total/apex (verified across the entire packet capture). This module produces them. All outputs are COMPUTED and must be labeled as estimates everywhere downstream.

---

## 1. Coordinate system, state, constants

- Axes (meters): **x** = downrange (toward target), **y** = height (up), **z** = lateral (+ = right of target line). Origin at the ball at impact, y=0 at the hitting surface.
- State: position **p** = (x,y,z), velocity **v** = (vx,vy,vz), spin vector **ω** (rad/s). Time **t** seconds.
- Constants (standard golf ball, R&A/USGA conformance limits):
  - mass `m = 0.04593 kg` (45.93 g)
  - diameter `d = 0.04267 m` (1.680 in), radius `r = d/2`
  - cross-section `A = π r² ≈ 1.4297e-3 m²`
  - gravity `g = 9.80665 m/s²`

---

## 2. Air density from altitude (this is what makes altitude matter — do it properly)

Use the ISA troposphere model, not a flat multiplier. At the session altitude `h` (meters; from `Environment.altitudeM`), optional temperature override:

```
T0 = 288.15 K (or 273.15 + temperatureC if provided at sea level)
L  = 0.0065 K/m           # temperature lapse rate
p0 = 101325 Pa
g  = 9.80665, R = 8.31447, M = 0.0289644   # M = molar mass of air
Rs = 287.058 J/(kg·K)      # specific gas constant for dry air

T(h) = T0 - L*h
p(h) = p0 * (T(h)/T0) ** (g*M/(R*L))
ρ(h) = p(h) / (Rs * T(h))
```

Sanity: ρ ≈ 1.225 kg/m³ at sea level, ≈ 1.006 at ~1,850 m (the device's reported altitude / ~6,070 ft). That ~18% density drop is the whole reason a home-altitude model beats the device's fixed assumption. (Optional refinement: adjust `Rs`/density for humidity; not required for v1.)

---

## 3. Forces (equations of motion)

Three forces act; integrate `dv/dt = (F_gravity + F_drag + F_magnus)/m`, `dp/dt = v`.

- **Gravity:** `F_gravity = (0, -m g, 0)`
- **Drag** (opposes velocity): with speed `V = |v|`,
  `F_drag = -½ · ρ · A · Cd · V · v`   (vector form; the extra `v` (not `V`) carries direction)
- **Magnus / lift** (perpendicular to velocity, in the plane of ω×v):
  `F_magnus = ½ · ρ · A · Cl · V² · ĝ`, where `ĝ = (ω × v) / |ω × v|`
  Backspin (ω roughly along −z for a right-handed target frame with a square face) produces upward lift; sidespin tilts the lift vector to curve the ball laterally (draw/fade). **Sidespin and rollspin must enter ω so the path curves** — a straight arc that ignores them is a bug.

`Cd` and `Cl` are **not constants** — see §4.

---

## 4. Aerodynamic coefficients (cite your source — do not invent numbers)

`Cd` and `Cl` are functions of the **spin ratio** `S` and Reynolds number `Re`:

```
ω_mag = |ω|                       # rad/s
S  = (r · ω_mag) / V              # dimensionless spin ratio (a.k.a. spin factor)
Re = ρ · V · d / μ,  μ ≈ 1.81e-5 Pa·s   # air dynamic viscosity
```

Take `Cd(S, Re)` and `Cl(S, Re)` from a **published, cited golf-ball aerodynamics dataset**, implemented as a lookup/interpolation or the source's closed-form fit. Acceptable primary sources (cite the one you use in code comments):

- **Quintavalla, S. J. (2002),** *"A generally applicable model for the aerodynamic behavior of golf balls in flight,"* USGA. — Purpose-built for trajectory simulation; gives Cd/Cl as explicit functions. **Preferred** if you can obtain it.
- **Bearman, P. W. & Harvey, J. K. (1976),** *"Golf ball aerodynamics,"* Aeronautical Quarterly 27. — Classic dimpled-sphere wind-tunnel Cd/Cl vs spin.
- **Lyu, B., Kensrud, J., Smith, L. (2018–2020),** WSU Sports Science Lab wind-tunnel golf-ball data. — Modern, high-Re measurements.
- **Smits, A. J. & Smith, D. R. (1994),** *"A new aerodynamic model of a golf ball in flight."*

**Starting parameterization (documented approximation — validate and tune to a cited dataset before trusting distances):** in the operating range of real shots, dimpled-ball behavior is roughly

```
Cd ≈ 0.24 + 0.14 · S            # ~0.21–0.28 typical; rises with spin
Cl ≈ 0.54 · S / (0.10 + S)      # saturating; ~0.1–0.28 typical; ~0 at S→0
```

These closed forms are a **reasonable starting point, not authoritative** — they exist so the model runs and can be sanity-checked, and they must be reconciled against one of the cited datasets and tuned so §7 targets are met. Prefer the source's own tabulated Cd/Cl with interpolation over these approximations when accuracy matters. Document exactly what you used and its provenance.

---

## 5. Spin decay

Spin bleeds off in flight; ignoring it overstates carry and curve. Apply exponential decay:

```
ω(t) = ω0 · exp(-t / τ),   τ ≈ 20 s   # tune within ~15–25 s to the cited model / observed data
```

(Some models decay spin as a function of air resistance torque; the exponential form with τ is the common, sufficient approximation. Document your choice.)

---

## 6. Integration, initial conditions, landing, rollout

- **Initial conditions from `LaunchConditions`:** convert to vectors.
  ```
  V0 = ballSpeedMs
  vla = launchAngleDeg (deg), hla = launchDirectionDeg (deg, + = right)
  vx = V0 · cos(vla) · cos(hla)
  vy = V0 · sin(vla)
  vz = V0 · cos(vla) · sin(hla)
  ```
  Build ω0 from backspin/sidespin/rollspin (rpm → rad/s = rpm·2π/60), oriented so backspin lifts and sidespin curves toward the low side of the axis; document the sign convention and keep it consistent with the axes in §1. Roll (rifle) spin has a secondary effect; include it in ω.
- **Integrator:** classic **RK4**, fixed step `dt = 0.001 s` (1 ms). Recompute forces each stage. Append a `FlightPathPoint {t,x,y,z}` per step (or decimate to keep `path` a reasonable length, e.g. every ~5–10 ms, while integrating at 1 ms).
- **Termination:** stop when `y ≤ 0` after apex. Interpolate the exact ground-crossing for `carryM` and `landing`, and compute `descentDeg = atan2(-vy, sqrt(vx²+vz²))` at impact, `apexM = max(y)`, `flightTimeS = t_land`, `offlineM = z_land`.
- **Rollout → `totalM`:** a simple, documented model is sufficient for v1 — e.g. rollout as a function of descent angle and landing speed (steeper/softer = less roll), or a category-based fraction. Keep it isolated and clearly approximate; `total = carry + rollout`. (A full bounce/turf-interaction model is out of scope.)

Output the full `FlightResult` (path + carryM, totalM, apexM, descentDeg, flightTimeS, offlineM, landing, rolloutM, `computed: true`).

---

## 7. Validation targets (sanity, not exactness)

Unit-test against archetypal launch conditions. These are **ballpark carry ranges at sea level** from published launch-condition→carry references (e.g. Trackman/‌fitting optimizers); tune coefficients until the model lands in-range, then verify altitude behavior:

| Shot archetype | Ball speed | Launch (VLA) | Backspin | Expected carry @ sea level |
|---|---|---|---|---|
| Tour driver | ~74 m/s (165 mph) | ~11° | ~2600 rpm | ~250–275 yd → ~229–251 m |
| Mid 7-iron | ~54 m/s (120 mph) | ~17° | ~7000 rpm | ~160–175 yd → ~146–160 m |
| Wedge | ~40 m/s (90 mph) | ~28° | ~9000 rpm | ~95–115 yd → ~87–105 m |

(Convert carefully — targets are commonly quoted in yards; store/compare in meters.) **Altitude check:** the same driver inputs at ~1,850 m must carry meaningfully farther (order ~6–9%) than at sea level — this is the core reason the module exists. **Curvature check:** positive sidespin curves the ball to the right (fade for a right-hander) and negative to the left, with magnitude increasing with sidespin; a shot with zero sidespin finishes on the target line (`offlineM ≈ HLA-only`).

Write these as assertions with tolerance bands. If exact Uneekor/VIEW matching proves impossible, prefer a transparent, cited, documented model over a black-box tuned to one launch monitor — per the project's data-integrity standard.

---

## 8. Interface (from CONTRACTS.md)

```ts
import type { FlightModel, LaunchConditions, Environment, FlightResult } from '@golf/types';
// simulate(launch: LaunchConditions, env: Environment): FlightResult   // computed: true
```

Pure module: no device, no DB, no React Native APIs. Deterministic. Fully unit-tested standalone (`nx test flight-model`).
