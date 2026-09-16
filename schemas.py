from typing import Optional

from pydantic import BaseModel


class AdminUserPatch(BaseModel):
    is_admin: Optional[bool] = None
    is_active: Optional[bool] = None
