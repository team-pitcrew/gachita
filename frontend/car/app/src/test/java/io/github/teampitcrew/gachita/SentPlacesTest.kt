package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SentPlacesTest {
    private val mart = Place(37.414, 127.096, "하나로마트")

    @Test fun navigationCoordinatesWinWhenPresent() {
        val sent = SentPlaces().apply { remember(mart) }
        assertEquals(Place(37.5, 127.1, "하나로마트"), arrivalPlaceOrSent("하나로마트", 37.5, 127.1, sent))
    }

    @Test fun missingCoordinatesFallBackToTheSentPlaceWithThatName() {
        val sent = SentPlaces().apply { remember(mart); remember(Place(37.406, 127.101, "강릉 숙소")) }
        assertEquals(mart, arrivalPlaceOrSent("하나로마트", 0.0, 0.0, sent))
        assertEquals(mart, arrivalPlaceOrSent(" 하나로마트 ", null, null, sent))
        assertEquals(Place(37.406, 127.101, "강릉 숙소"), arrivalPlaceOrSent("강릉 숙소", 0.0, 0.0, sent))
    }

    @Test fun nameContainedEitherWayMatches() {
        val sent = SentPlaces().apply { remember(Place(1.0, 2.0, "용인휴게소")); remember(Place(3.0, 4.0, "하남드림휴게소")) }
        assertEquals(Place(1.0, 2.0, "용인휴게소 강릉방향"), arrivalPlaceOrSent("용인휴게소 강릉방향", 0.0, 0.0, sent)) // the navigation adds a direction
        assertEquals(Place(3.0, 4.0, "하남드림"), arrivalPlaceOrSent("하남드림", 0.0, 0.0, sent)) // or shortens the name
    }

    @Test fun unknownOrBlankNamesAndBadPointsGiveNothing() {
        val sent = SentPlaces().apply { remember(mart); remember(Place(0.0, 0.0, "어딘가")); remember(Place(37.0, 127.0, " ")) }
        assertNull(arrivalPlaceOrSent("강릉역", 0.0, 0.0, sent))
        assertNull(arrivalPlaceOrSent("", 0.0, 0.0, sent))
        assertNull(arrivalPlaceOrSent("어딘가", 0.0, 0.0, sent))
    }

    @Test fun keepsOnlyTheNewestPlaces() {
        val sent = SentPlaces(max = 2).apply { remember(Place(1.0, 1.0, "a")); remember(Place(2.0, 2.0, "b")); remember(Place(3.0, 3.0, "c")) }
        assertNull(sent.find("a")); assertEquals(Place(3.0, 3.0, "c"), sent.find("c"))
    }
}
