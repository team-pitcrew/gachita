package io.github.teampitcrew.gachita

/**
 * Demo and E2E only (T150, debug builds): `--es stops "lat,lng,name;lat,lng,name"` are the places to visit before the `--es route`
 * destination. The demo flow (demo.py) needs a waypoint (the mart) and a final destination (the lodge) so the arrival briefing can tell
 * a stop ('장보고 여행 계속') from the end of the trip ('여행 마치고 기록 보기'). At most two, like the navi call (Car.route).
 * A malformed part is dropped rather than guessed.
 */
internal fun demoStops(arg: String?): List<Place> = arg.orEmpty().split(";").mapNotNull { part ->
    val f = part.split(",").map { it.trim() }
    val lat = f.getOrNull(0)?.toDoubleOrNull()
    val lng = f.getOrNull(1)?.toDoubleOrNull()
    val name = f.getOrNull(2).orEmpty()
    if (f.size != 3 || lat == null || lng == null || name.isEmpty() || lat !in -90.0..90.0 || lng !in -180.0..180.0) null else Place(lat, lng, name)
}.take(2)
