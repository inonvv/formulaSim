# FormulaSim Master Build Specification
Goal:
Create an interactive frontend experience centered on a 3D racing car model (F1/F2/F3/GT).

Core Element:
A high‑fidelity 3D car placed in the center of the screen with two states:
- Idle Mode (0 km/h)
- Motion Mode (speed-based animation)

Interactive Effects (user‑triggered):
- Airflow/Aerodynamics: visual air streaks + pressure zones reacting to speed.
- Rain Mode: droplets, spray, wet-surface reflections.
- Optimal Race Weather: clean lighting, track shimmer, ideal conditions.

User Controls:
- Car selection (F1/F2/F3/GT)
- Speed selection (idle → high speed)
- Environment toggles (Airflow / Rain / Optimal Weather)
- Camera modes (Orbit / Trackside / Cockpit / Drone)
- Play/Pause animation

Experience:
Cinematic, educational, interactive. 
A mini wind‑tunnel simulator showcasing physics + environment effects.


## Core Principle

Never allow inconsistent trip state. Validation must protect data integrity. State must always mirror selected destinations. Keep architecture clean and predictable. Prefer clarity over cleverness.


## Development Approach — TDD

Follow test-driven development. Write tests **before** developing features or fixing bugs.


