<div class="acp-page-container">
    <div class="row">
        <div class="col-lg-12">
            <div class="panel panel-primary">
                <div class="panel-heading">
                    <h3 class="panel-title">
                        <i class="fa fa-shopping-cart"></i> הגדרות AliExpress Affiliate
                    </h3>
                </div>
                <div class="panel-body">
                    <form id="cline-links-settings">
                        <div class="form-group">
                            <label for="appKey">App Key</label>
                            <input type="text" id="appKey" name="appKey" class="form-control" placeholder="לדוגמה: 529864" />
                        </div>
                        <div class="form-group">
                            <label for="appSecret">App Secret</label>
                            <input type="password" id="appSecret" name="appSecret" class="form-control" placeholder="הכנס את ה-Secret שלך" />
                        </div>
                        <div class="form-group">
                            <label for="trackingId">Tracking ID</label>
                            <input type="text" id="trackingId" name="trackingId" class="form-control" placeholder="לדוגמה: api" />
                        </div>
                        
                        <hr />

                        <div class="form-group">
                            <label>
                                <input type="checkbox" name="enabled" /> הפעל המרת קישורים אוטומטית
                            </label>
                        </div>

                        <hr />

                        <div class="form-group">
                            <label>Tracking ID לפי משתמש</label>
                            <p class="help-block">
                                ניתן להגדיר Tracking ID מותאם אישית למשתמשים מסוימים - כל קישור
                                שיפורסם ע"י המשתמש הזה (בפוסט או בהודעת צ'אט) יומר עם ה-Tracking ID
                                שהוגדר לו כאן, במקום ה-Tracking ID הכללי שמוגדר למעלה.
                            </p>
                            <input type="text" id="user-override-search" class="form-control" placeholder="הקלד שם משתמש להוספה..." />
                            <input type="hidden" name="userOverrides" id="userOverrides" value="[]" />
                            <table class="table" id="user-overrides-table">
                                <thead>
                                    <tr>
                                        <th>משתמש</th>
                                        <th>Tracking ID</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody id="user-overrides-list"></tbody>
                            </table>
                        </div>

                        <button class="btn btn-primary" id="save-settings" type="button">
                            <i class="fa fa-save"></i> שמור הגדרות
                        </button>
                    </form>
                </div>
            </div>
        </div>
    </div>
</div>