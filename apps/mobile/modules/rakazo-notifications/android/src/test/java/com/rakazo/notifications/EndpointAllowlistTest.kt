package com.rakazo.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EndpointAllowlistTest {
  @Test
  fun `matches the shared JS endpoint cases`() {
    val lines = requireNotNull(javaClass.getResource("/endpoint-allowlist-cases.json")).readText().lines()
      .map { it.trim() }
      .filter { it.isNotEmpty() && it != "[" && it != "]" }
    assertTrue(lines.isNotEmpty())
    for (line in lines) {
      val match = requireNotNull(CASE.matchEntire(line)) { "Unreadable case: $line" }
      val (endpoint, allowed) = match.destructured
      assertEquals(endpoint, allowed.toBoolean(), isAllowedNotificationEndpoint(endpoint))
    }
  }

  private companion object {
    val CASE = Regex("""\["([^"\\]*)", (true|false)],?""")
  }
}
