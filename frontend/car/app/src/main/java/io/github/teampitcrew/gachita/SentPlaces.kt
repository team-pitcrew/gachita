package io.github.teampitcrew.gachita

/**
 * Places this app itself asked the navigation to go to: the route destination, its waypoints (demo `--es stops`) and stops added
 * on the way (T9 rest stops). The Pleos navigation reports a waypoint's name but not always its coordinates (0.0 on the emulator),
 * and without coordinates the arrival check (T113) has to give up. When that happens the app uses the coordinates it sent for the
 * place with that name. Nothing else changes: the server still checks the vehicle position against them (250 m) and parking.
 * Only the last few places are kept; a place sent again replaces the older one with the same name.
 */
internal class SentPlaces(private val max: Int = 8) {
    private val byName = LinkedHashMap<String, Place>()

    @Synchronized fun remember(p: Place) {
        val name = p.name.trim()
        if (name.isEmpty() || !vehiclePoint(p.lat, p.lng)) return
        byName.remove(name); byName[name] = p
        while (byName.size > max) byName.remove(byName.keys.first())
    }

    /** The sent place for a navigation name: the same name, else the newest one whose name contains it or is contained in it. */
    @Synchronized fun find(name: String?): Place? {
        val n = name?.trim().orEmpty()
        if (n.isEmpty()) return null
        return byName[n] ?: byName.values.lastOrNull { val s = it.name.trim(); n.contains(s) || s.contains(n) }
    }
}

/** The navigation's next place with its own coordinates, or, when it gave none, with the coordinates this app sent for that name. */
internal fun arrivalPlaceOrSent(name: String?, lat: Double?, lng: Double?, sent: SentPlaces): Place? =
    arrivalPlace(name, lat, lng) ?: sent.find(name)?.let { Place(it.lat, it.lng, name!!.trim(), it.address) }
