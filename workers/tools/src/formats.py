"""The JSON schemas the tools register as request_format and response_format.

The engine stores them and never checks a call against them. find-slot says
duration is an integer, and a string duration from the model still reaches
the handler (bug 2).
"""

FIND_SLOT_REQUEST = {
    "type": "object",
    "description": "Who to meet, on which day, and for how long",
    "properties": {
        "attendee": {"type": "string", "format": "email", "description": "The attendee's email address"},
        "day": {"type": "string", "format": "date", "description": "The day to look for a slot on"},
        "duration": {"type": "integer", "minimum": 1, "description": "How long the meeting is, in minutes"},
    },
    "required": ["attendee", "day", "duration"],
}

FIND_SLOT_RESPONSE = {
    "type": "object",
    "description": "An afternoon slot on that day, in America/Chicago with its UTC offset",
    "properties": {
        "attendee": {"type": "string", "format": "email", "description": "The attendee the slot is for"},
        "start": {"type": "string", "format": "date-time", "description": "When the slot starts"},
        "end": {"type": "string", "format": "date-time", "description": "When the slot ends, duration minutes after the start"},
    },
    "required": ["attendee", "start", "end"],
}

SEND_REQUEST = {
    "type": "object",
    "description": "The invite to send",
    "properties": {
        "to": {"type": "string", "format": "email", "description": "Who gets the invite"},
        "subject": {"type": "string", "description": 'The subject line, such as "30 minutes, Tuesday"'},
        "start": {"type": "string", "format": "date-time", "description": "When the meeting starts"},
    },
    "required": ["to", "subject", "start"],
}

SEND_RESPONSE = {
    "type": "object",
    "description": "The email provider's reply",
    "properties": {
        "status": {"type": "string", "enum": ["accepted"], "description": "The provider took the invite"},
        "id": {"type": "string", "description": "The provider's id for the message, msg_ and 12 hex digits"},
    },
    "required": ["status", "id"],
}
